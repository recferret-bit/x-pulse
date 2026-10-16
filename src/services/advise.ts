import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { NormalizedTweet, PoolName } from '../domain.js';
import { silentLogger, type Logger } from '../logger.js';
import { calculateViralityScore, classifyInfluencerTier, optimalPostingWindowsUTC } from './scorer.js';
import type { TelegramNotifier } from './telegram-notifier.js';
import { normalizeTweet, type RawTweet, type TwitterApiClient } from './twitter-api.js';
import { composePostText } from './x-intent.js';

const EVIDENCE_LIMIT = 5;
const BEST_LIMIT = 8;
const QUERY_TERM_LIMIT = 6;
/** One page per slice. Three slices cover the week without paging through it. */
const ADVISE_PAGES_PER_SLICE = 1;
const DAY_MS = 24 * 60 * 60 * 1000;
export const ADVISE_LOOKBACK_MS = 7 * DAY_MS;
export const ADVISE_SLICE_COUNT = 3;

const TOPIC_STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'to', 'and', 'in', 'on', 'for', 'is', 'it', 'this', 'that', 'with',
  'from', 'at', 'by', 'or', 'be', 'as', 'are', 'was', 'if', 'we', 'you', 'your', 'our',
  'want', 'post', 'about', 'please', 'write', 'make', 'tweet', 'something', 'just', 'like',
  'how', 'what', 'when', 'into', 'my', 'mine', 'me', 'im', 'i', 'its',
  'shipped', 'shiped', 'shipping', 'built', 'made', 'released', 'launch', 'launched',
  'grew', 'grow', 'growing',
  'project', 'projects', 'code', 'general', 'multi', 'new', 'update', 'updates',
  'open', 'source', 'opensource', 'tool', 'tools', 'also',
  'gif', 'gifs', 'video', 'image', 'photo', 'screenshot', 'screenshots',
]);

const DOMAIN_TERMS = new Set(['solana', 'ethereum', 'bitcoin', 'rust', 'typescript', 'audit', 'anchor']);

export type ContentKind = 'text' | 'image' | 'gif' | 'video';

export interface AdviceEvidence {
  tweetId: string;
  url: string;
  authorUsername: string;
  followers: number;
  likes: number;
  viralityScore: number;
  hashtags: string[];
  text: string;
  hasMedia: boolean;
  contentKind: ContentKind;
  createdAt: string;
  reason: string;
}

export interface AdviceOption {
  kind: ContentKind;
  label: string;
  body: string;
  recommended: boolean;
  reason: string;
}

export interface BriefUnderstanding {
  intent: 'launch' | 'showcase';
  reading: string;
  subjects: string[];
  contextTerms: string[];
  supportTerms: string[];
  searchTerms: string[];
}

export interface PostAdvice {
  topic: string;
  query: string;
  reading: string;
  title: string;
  content: string;
  hashtags: string[];
  mentions: string[];
  bestTimeToPostUTC: string;
  contentKind: ContentKind;
  mediaNote: string;
  options: AdviceOption[];
  why: string;
  evidence: AdviceEvidence[];
  searched: number;
  kept: number;
}

export function readAdviseBrief(argv: readonly string[]): string {
  return argv
    .slice(3)
    .filter((part) => part !== '--')
    .join(' ')
    .trim();
}

export function understandBrief(brief: string): BriefUnderstanding {
  const normalized = brief.replace(/shiped/gi, 'shipped').replace(/\+/g, ' and ').replace(/\s+/g, ' ').trim();
  const intent = /\b(shipped|shipping|built|released|open[ -]?sourced|launch(?:ed)?)\b/i.test(normalized)
    ? 'launch'
    : 'showcase';
  const payload = normalized
    .replace(/^\s*i\s+(?:just\s+)?(?:want\s+to\s+post\s+about|shipped|shipping|built|made|released|open[ -]?sourced|launched)\s+(?:an?\s+)?/i, '')
    .trim();
  const subjects = subjectClauses(payload.length > 0 ? payload : normalized);
  const terms = topicTerms(payload.length > 0 ? payload : normalized);
  const contextTerms = terms.filter((term) => DOMAIN_TERMS.has(term));
  const supportTerms = terms.filter((term) => !DOMAIN_TERMS.has(term));
  const phrases = contextPhrases(payload.length > 0 ? payload : normalized);
  const searchTerms = unique([
    ...contextTerms,
    ...phrases,
    ...supportTerms,
  ]).slice(0, QUERY_TERM_LIMIT);
  const shown = subjects.map(polishPhrase);
  const about = shown.length >= 2
    ? `${shown.slice(0, -1).join(', ')}, and ${shown[shown.length - 1]}`
    : (shown[0] ?? polishPhrase(payload));
  const reading = intent === 'launch'
    ? `Read this as a launch post about ${about}.`
    : `Read this as a post you want to publish about ${about}.`;
  return { intent, reading, subjects: shown, contextTerms, supportTerms, searchTerms };
}

export function buildTopicQuery(brief: string): string {
  const terms = understandBrief(brief).searchTerms;
  if (terms.length === 0) {
    throw new Error('Describe the post with a few concrete words so similar posts can be searched.');
  }
  const [anchor, ...rest] = terms;
  const clause = rest.length === 0
    ? quoteTerm(anchor ?? '')
    : `${quoteTerm(anchor ?? '')} (${rest.map((term) => quoteTerm(term)).join(' OR ')})`;
  return `${clause} min_faves:10 -is:retweet lang:en -airdrop -giveaway -pump -presale -whitelist -"$SOL"`;
}

export interface AdviseTimeSlice {
  since: number;
  until: number;
}

/** Three contiguous slices of the last 7 days, newest first. Unix seconds. */
export function adviseLookbackSlices(now: Date): AdviseTimeSlice[] {
  const end = Math.floor(now.getTime() / 1000);
  const span = Math.floor(ADVISE_LOOKBACK_MS / 1000 / ADVISE_SLICE_COUNT);
  return Array.from({ length: ADVISE_SLICE_COUNT }, (_, index) => ({
    until: end - index * span,
    since: end - (index + 1) * span,
  }));
}

export function queryForSlice(baseQuery: string, slice: AdviseTimeSlice): string {
  return `${baseQuery} since_time:${slice.since} until_time:${slice.until}`;
}

export function contentKindOf(text: string, hasMedia: boolean, mediaTypes: readonly string[] = []): ContentKind {
  const types = mediaTypes.map((type) => type.toLowerCase());
  if (types.includes('video')) return 'video';
  if (types.includes('animated_gif') || types.includes('gif')) return 'gif';
  if (types.includes('photo') || types.includes('image')) return 'image';
  if (/\b(gif|gifs)\b/i.test(text)) return 'gif';
  if (/\b(video|clip|trailer)\b/i.test(text)) return 'video';
  if (/\b(screenshot|screenshots|photo|image)\b/i.test(text)) return 'image';
  if (hasMedia) return 'image';
  return 'text';
}

export function composeAdvice(input: {
  topic: string;
  query: string;
  tweets: readonly AdvisedTweet[];
  searched: number;
}): PostAdvice {
  const understood = understandBrief(input.topic);
  const matchTerms = unique([...understood.contextTerms, ...understood.supportTerms]);
  const relevant = input.tweets.filter((tweet) => matchesContext(tweet.text, understood));
  const ranked = [...relevant].sort((a, b) => {
    const byOverlap = sharedTerms(b.text, matchTerms).length - sharedTerms(a.text, matchTerms).length;
    if (byOverlap !== 0) return byOverlap;
    return byScoreThenId(a, b);
  });
  const best = ranked.slice(0, BEST_LIMIT);
  const evidence = best.slice(0, EVIDENCE_LIMIT).map((tweet, index) => {
    const contentKind = tweet.contentKind ?? contentKindOf(tweet.text, tweet.hasMedia);
    return {
      tweetId: tweet.id,
      url: tweet.url,
      authorUsername: tweet.authorUsername,
      followers: tweet.authorFollowers,
      likes: tweet.likes,
      viralityScore: tweet.viralityScore,
      hashtags: tweet.hashtags,
      text: tweet.text,
      hasMedia: tweet.hasMedia,
      contentKind,
      createdAt: tweet.createdAt,
      reason: evidenceReason(tweet, index + 1, best.length, matchTerms, contentKind),
    };
  });

  const hashtags = chooseHashtags(evidence, matchTerms);
  const windows = optimalPostingWindowsUTC(
    best.map((tweet) => ({ createdAt: tweet.createdAt, viralityScore: tweet.viralityScore })),
    1,
  );
  const bestTimeToPostUTC = windows[0] ?? 'not enough similar posts';
  const lead = evidence[0];
  const mentions = lead && classifyInfluencerTier(lead.followers) ? [lead.authorUsername] : [];
  const title = titleFromUnderstanding(understood);
  const options = buildOptions(understood, evidence);
  const recommended = options.find((option) => option.recommended) ?? options[0];
  const contentKind = recommended?.kind ?? 'text';
  const content = recommended?.body ?? 'State the result in the first line and name the constraint in the second.';
  const mediaNote = recommended?.reason ?? 'No similar post cleared the filters.';

  const ignored = input.tweets.length - relevant.length;
  const why = lead
    ? `${understood.reading} A similar post had to match that context, not any single filler word. The search sampled the last 7 days in three slices, one page each. Searched X with ${input.query}. ${input.searched} posts came back, ${input.tweets.length} passed the spam and repost filters, and ${ignored} of those were off-context. The content type is ${kindLabel(contentKind)} because that format holds the most virality among the ${evidence.length} matches. ${bestTimeToPostUTC} is 30 minutes before the UTC hour where those matches clustered. ${lead.reason}`
    : `${understood.reading} Searched X with ${input.query}. ${input.searched} posts came back and none matched that context. The drafts below are written from the brief only. There is no format or timing evidence.`;

  return {
    topic: input.topic,
    query: input.query,
    reading: understood.reading,
    title,
    content,
    hashtags,
    mentions,
    bestTimeToPostUTC,
    contentKind,
    mediaNote,
    options,
    why,
    evidence,
    searched: input.searched,
    kept: relevant.length,
  };
}

export async function runAdvise(input: {
  brief: string;
  twitter: TwitterApiClient;
  telegram: TelegramNotifier;
  now?: Date;
  logger?: Logger;
  maxPages?: number;
  workspaceDir?: string;
}): Promise<PostAdvice> {
  const logger = input.logger ?? silentLogger;
  const now = input.now ?? new Date();
  const topic = input.brief.trim();
  const query = buildTopicQuery(topic);
  const pool = poolForBrief(topic);
  const slices = adviseLookbackSlices(now);
  const pagesPerSlice = Math.min(input.maxPages ?? ADVISE_PAGES_PER_SLICE, ADVISE_PAGES_PER_SLICE);
  const oldest = now.getTime() - ADVISE_LOOKBACK_MS;
  const seen = new Set<string>();
  const raws: RawTweet[] = [];
  for (const slice of slices) {
    const sliced = queryForSlice(query, slice);
    logger.info('advise search', { query: sliced, pool });
    const page = await input.twitter.searchPool(sliced, { maxPages: pagesPerSlice });
    for (const raw of page) {
      if (seen.has(raw.id)) continue;
      seen.add(raw.id);
      raws.push(raw);
    }
  }
  const tweets: AdvisedTweet[] = [];
  for (const raw of raws) {
    const normalized = normalizeTweet(raw, pool, now);
    if (!normalized) continue;
    if (new Date(normalized.createdAt).getTime() < oldest) continue;
    tweets.push({
      ...normalized,
      contentKind: contentKindOf(normalized.text, normalized.hasMedia, mediaTypesOf(raw)),
      viralityScore: calculateViralityScore(
        {
          likes: normalized.likes,
          retweets: normalized.retweets,
          replies: normalized.replies,
          quotes: normalized.quotes,
          authorFollowers: normalized.authorFollowers,
          createdAt: normalized.createdAt,
        },
        now,
      ),
    });
  }

  const advice = composeAdvice({ topic, query, tweets, searched: raws.length });
  if (input.workspaceDir) await writeAdvice(input.workspaceDir, advice);
  await input.telegram.sendAdvise(advice);
  return advice;
}

export function renderAdviceMarkdown(advice: PostAdvice): string {
  const evidence = advice.evidence.map((item, index) =>
    [
      `### ${index + 1}. @${item.authorUsername}`,
      '',
      item.reason,
      '',
      item.text,
      '',
      item.url,
      '',
    ].join('\n'),
  );
  return [
    '# One-shot post advice',
    '',
    `Topic: ${advice.topic}`,
    '',
    advice.reading,
    '',
    `Search: \`${advice.query}\``,
    '',
    `## ${advice.title}`,
    '',
    `Content type: ${kindLabel(advice.contentKind)}`,
    '',
    advice.content,
    '',
    '## Proposed posts',
    '',
    ...advice.options.map((option, index) => renderProposedPost(advice, option, index)),
    '## Why',
    '',
    advice.why,
    '',
    '## Evidence',
    '',
    ...(evidence.length > 0 ? evidence : ['No similar post cleared the filters.', '']),
  ].join('\n');
}

function topicTerms(brief: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const match of brief.toLowerCase().matchAll(/\p{L}[\p{L}\p{N}]*(?:-\p{L}[\p{L}\p{N}]*)+/gu)) {
    const phrase = match[0];
    if (phrase && !seen.has(phrase)) {
      seen.add(phrase);
      terms.push(phrase);
    }
  }
  for (const token of brief.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (token.length < 3 || PURE_NUMBER.test(token) || TOPIC_STOPWORDS.has(token) || seen.has(token)) continue;
    seen.add(token);
    terms.push(token);
  }
  return terms.sort((a, b) => specificity(b) - specificity(a) || a.localeCompare(b));
}

function specificity(term: string): number {
  let score = term.length;
  if (term.includes('-')) score += 8;
  if (DOMAIN_TERMS.has(term)) score += 20;
  return score;
}

function quoteTerm(term: string): string {
  return term.includes('-') || /\s/.test(term) ? `"${term}"` : term;
}

function sharedTerms(text: string, terms: readonly string[]): string[] {
  const haystack = text.toLowerCase();
  return terms.filter((term) => haystack.includes(term));
}

function subjectClauses(payload: string): string[] {
  const raw = payload.split(/\s+and\s+/i).map((part) => part.replace(/\s+/g, ' ').trim()).filter((part) => part.length > 0);
  const merged: string[] = [];
  for (const part of raw) {
    const meaningful = topicTerms(part);
    if (meaningful.length === 0 && merged.length > 0) {
      merged[merged.length - 1] = `${merged[merged.length - 1]} and ${part}`;
      continue;
    }
    if (meaningful.length === 0) continue;
    merged.push(part);
  }
  return merged.length > 0 ? merged : [payload];
}

function contextPhrases(payload: string): string[] {
  const text = payload.toLowerCase();
  const phrases: string[] = [];
  if (text.includes('solana') && text.includes('audit')) phrases.push('solana audit');
  if (text.includes('audit') && text.includes('library')) phrases.push('audit library');
  const hyphenated = text.match(/\p{L}[\p{L}\p{N}]*(?:-\p{L}[\p{L}\p{N}]*)+/gu) ?? [];
  for (const phrase of hyphenated) {
    if (!TOPIC_STOPWORDS.has(phrase)) phrases.push(phrase);
  }
  return phrases;
}

function matchesContext(text: string, understood: BriefUnderstanding): boolean {
  const anchors = sharedTerms(text, understood.contextTerms);
  const support = sharedTerms(text, understood.supportTerms);
  if (understood.contextTerms.length > 0 && understood.supportTerms.length > 0) {
    return anchors.length + (text.toLowerCase().includes('solana audit') ? 1 : 0) >= 1 && (anchors.length + support.length) >= 2;
  }
  const all = sharedTerms(text, understood.searchTerms);
  return all.length >= (understood.searchTerms.length === 1 ? 1 : 2);
}

function titleFromUnderstanding(understood: BriefUnderstanding): string {
  const about = understood.subjects.length >= 2
    ? `${understood.subjects[0]} and ${understood.subjects.slice(1).join(' and ')}`
    : (understood.subjects[0] ?? 'this');
  const sentence = understood.intent === 'launch' ? `Shipped ${about}` : about;
  const chars = [...sentence];
  if (chars.length <= 120) return sentence;
  const cut = chars.slice(0, 120).join('');
  const space = cut.lastIndexOf(' ');
  return space > 40 ? cut.slice(0, space) : cut;
}

function polishPhrase(phrase: string): string {
  return phrase.replace(/\bsolana\b/gi, 'Solana').replace(/\s+/g, ' ').trim();
}

function unique(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

export function renderOptionPost(advice: Pick<PostAdvice, 'title' | 'hashtags' | 'mentions' | 'bestTimeToPostUTC'>, body: string): string {
  return composePostText({
    hook: advice.title,
    body,
    recommendedHashtags: advice.hashtags,
    accountsToMention: advice.mentions,
    bestTimeToPostUTC: advice.bestTimeToPostUTC,
  });
}

function renderProposedPost(advice: PostAdvice, option: AdviceOption, index: number): string {
  const hashtags = advice.hashtags.map((tag) => `#${tag}`).join(' ') || 'none';
  return [
    `### ${index + 1}. ${option.label}`,
    '',
    `- Recommended: ${option.recommended ? 'yes' : 'no'}`,
    `- Label: ${option.label}`,
    `- Time: ${advice.bestTimeToPostUTC} UTC`,
    `- Hashtags: ${hashtags}`,
    '- Text:',
    '',
    '```',
    renderOptionPost(advice, option.body),
    '```',
    '',
    `- Why: ${option.reason}`,
    '',
  ].join('\n');
}

function chooseHashtags(evidence: readonly AdviceEvidence[], terms: readonly string[]): string[] {
  const counts = new Map<string, number>();
  const names = new Set(evidence.map((item) => item.authorUsername.toLowerCase()));
  for (const item of evidence) {
    for (const tag of item.hashtags) {
      const key = tag.toLowerCase().replace(/^#+/, '');
      if (key.length < 2 || names.has(key) || TOPIC_STOPWORDS.has(key)) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const ranked = [...counts.entries()].sort((a, b) => {
    const aTopic = terms.some((term) => a[0].includes(term) || term.includes(a[0])) ? 1 : 0;
    const bTopic = terms.some((term) => b[0].includes(term) || term.includes(b[0])) ? 1 : 0;
    if (aTopic !== bTopic) return bTopic - aTopic;
    if (a[1] !== b[1]) return b[1] - a[1];
    return a[0].localeCompare(b[0]);
  });
  const topical = ranked.filter(([tag, count]) => count >= 2 || terms.some((term) => tag.includes(term) || term.includes(tag)));
  if (topical.length > 0) return topical.slice(0, 3).map(([tag]) => tag);
  return terms.filter((term) => !term.includes('-') && !term.includes(' ')).slice(0, 3);
}

type AdvisedTweet = NormalizedTweet & { contentKind?: ContentKind };

function buildOptions(understood: BriefUnderstanding, evidence: readonly AdviceEvidence[]): AdviceOption[] {
  const resultCopy = subjectCopy(understood);
  if (evidence.length === 0) {
    return [
      {
        kind: 'text',
        label: 'Text, result first',
        body: resultCopy,
        recommended: true,
        reason: 'No similar post matched the context, so this draft uses your brief only.',
      },
      {
        kind: 'text',
        label: 'Text, constraint first',
        body: 'Shipping the code, not a trailer.',
        recommended: false,
        reason: 'A second wording of the same text post. There is no media evidence for a GIF, video, or still.',
      },
    ];
  }

  const totalWeight = evidence.reduce((sum, item) => sum + item.viralityScore, 0);
  const groups = new Map<ContentKind, { weight: number; count: number; example: AdviceEvidence }>();
  for (const item of evidence) {
    const current = groups.get(item.contentKind);
    if (!current) {
      groups.set(item.contentKind, { weight: item.viralityScore, count: 1, example: item });
    } else {
      current.weight += item.viralityScore;
      current.count += 1;
    }
  }

  const ranked = [...groups.entries()].sort((a, b) => b[1].weight - a[1].weight || a[0].localeCompare(b[0]));
  const leadKind = ranked[0]?.[0] ?? 'text';
  const formatOptions = ranked
    .filter(([kind]) => kind !== 'text')
    .map(([kind, group]) => ({
      kind,
      label: kindLabel(kind),
      body: formatBody(kind),
      recommended: kind === leadKind,
      reason: formatReason(kind, group.count, evidence.length, group.weight, totalWeight, group.example.authorUsername),
    }));

  const textGroup = groups.get('text');
  const textReason = textGroup
    ? formatReason('text', textGroup.count, evidence.length, textGroup.weight, totalWeight, textGroup.example.authorUsername)
    : `None of the ${evidence.length} strongest posts were text-only. They led with ${kindLabel(leadKind)}. Use text only when you cannot attach that format.`;
  const variants: AdviceOption[] = [
    {
      kind: 'text',
      label: 'Text, result first',
      body: resultCopy,
      recommended: leadKind === 'text',
      reason: textReason,
    },
    {
      kind: 'text',
      label: 'Text, constraint first',
      body: 'Shipping the code, not a trailer.',
      recommended: false,
      reason: textReason,
    },
  ];

  const options = [...formatOptions, ...variants];
  if (!options.some((option) => option.recommended)) {
    const first = options[0];
    if (first) first.recommended = true;
  }
  return options;
}

function subjectCopy(understood: BriefUnderstanding): string {
  if (understood.subjects.length >= 2) {
    return `Two parts: ${understood.subjects[0]}, and ${understood.subjects[1]}.`;
  }
  return understood.subjects[0] ? `This is about ${understood.subjects[0]}.` : 'The repo is the post.';
}

function formatBody(kind: ContentKind): string {
  if (kind === 'gif') return 'Attach a 1–2 second loop of it running.';
  if (kind === 'video') return 'Attach a silent clip under 15 seconds.';
  if (kind === 'image') return 'Attach one still of the result.';
  return 'The repo is the post.';
}

function formatReason(
  kind: ContentKind,
  count: number,
  total: number,
  weight: number,
  totalWeight: number,
  example: string,
): string {
  const share = totalWeight > 0 ? Math.round((weight / totalWeight) * 100) : 0;
  return `${count} of ${total} strongest posts used ${kindLabel(kind)} and hold ${share}% of their virality. @${example} is the example.`;
}

function kindLabel(kind: ContentKind): string {
  if (kind === 'gif') return 'GIF';
  if (kind === 'video') return 'video';
  if (kind === 'image') return 'image';
  return 'text';
}

function evidenceReason(
  tweet: NormalizedTweet,
  rank: number,
  total: number,
  briefTerms: readonly string[],
  contentKind: ContentKind,
): string {
  const hour = new Date(tweet.createdAt).getUTCHours();
  const uniqueOverlap = sharedTerms(tweet.text, briefTerms);
  const overlapClause = uniqueOverlap.length > 0
    ? ` It shares these words with your brief: ${uniqueOverlap.join(', ')}.`
    : ' It does not repeat your brief word for word, but it ranked among the strongest posts the search returned.';
  const tags = tweet.hashtags.length > 0 ? ` Tags: ${tweet.hashtags.map((tag) => `#${tag}`).join(' ')}.` : '';
  return `Rank ${rank} of ${total}. Format ${kindLabel(contentKind)}. Virality ${formatScore(tweet.viralityScore)} from ${tweet.likes} likes, ${tweet.retweets} reposts, ${tweet.replies} replies, and ${tweet.quotes} quotes on an account with ${tweet.authorFollowers} followers. Posted in UTC hour ${hour}.${tags}${overlapClause}`;
}

function mediaTypesOf(raw: { extendedEntities?: { media?: { type?: string }[] }; extended_entities?: { media?: { type?: string }[] }; entities?: { media?: { type?: string }[] } }): string[] {
  const bags = [raw.extendedEntities?.media, raw.extended_entities?.media, raw.entities?.media];
  const types: string[] = [];
  for (const bag of bags) {
    if (!bag) continue;
    for (const item of bag) {
      if (item.type) types.push(item.type);
    }
  }
  return types;
}

function poolForBrief(brief: string): PoolName {
  const text = brief.toLowerCase();
  const game = /game|indie|steam|wishlist|gamedev/.test(text);
  const chain = /solana|onchain|web3/.test(text);
  if (game && chain) return 'intersection';
  if (chain) return 'solana';
  return 'indiedev';
}

function byScoreThenId(a: NormalizedTweet, b: NormalizedTweet): number {
  if (a.viralityScore !== b.viralityScore) return b.viralityScore - a.viralityScore;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

function formatScore(score: number): string {
  if (!Number.isFinite(score) || score === 0) return '0';
  return Math.abs(score) >= 0.01 ? score.toFixed(3) : score.toPrecision(3);
}

const PURE_NUMBER = /^\p{N}+$/u;

async function writeAdvice(workspaceDir: string, advice: PostAdvice): Promise<void> {
  const reports = path.join(workspaceDir, 'reports');
  await mkdir(reports, { recursive: true });
  await writeFile(path.join(reports, 'advise_latest.json'), `${JSON.stringify(advice, null, 2)}\n`, 'utf8');
  await writeFile(path.join(reports, 'advise_latest.md'), renderAdviceMarkdown(advice), 'utf8');
}
