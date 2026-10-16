import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { NormalizedTweet, PoolName } from '../domain.js';
import { silentLogger, type Logger } from '../logger.js';
import { aggregateTerms, calculateViralityScore, classifyInfluencerTier, optimalPostingWindowsUTC } from './scorer.js';
import type { TelegramNotifier } from './telegram-notifier.js';
import { normalizeTweet, type TwitterApiClient } from './twitter-api.js';

const EVIDENCE_LIMIT = 5;
const BEST_LIMIT = 8;
const QUERY_TERM_LIMIT = 6;

const TOPIC_STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'to', 'and', 'in', 'on', 'for', 'is', 'it', 'this', 'that', 'with',
  'from', 'at', 'by', 'or', 'be', 'as', 'are', 'was', 'if', 'we', 'you', 'your', 'our',
  'want', 'post', 'about', 'please', 'write', 'make', 'tweet', 'something', 'just', 'like',
  'how', 'what', 'when', 'into', 'my', 'mine', 'me', 'im', 'i', 'its', 'on', 'a',
]);

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

export interface PostAdvice {
  topic: string;
  query: string;
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

export function buildTopicQuery(brief: string): string {
  const terms = topicTerms(brief).slice(0, QUERY_TERM_LIMIT);
  if (terms.length === 0) {
    throw new Error('Describe the post with a few concrete words so similar posts can be searched.');
  }
  const clause = terms.map((term) => (/\s/.test(term) ? `"${term}"` : term)).join(' OR ');
  return `(${clause}) min_faves:10 -is:retweet lang:en -airdrop -giveaway -pump -presale -whitelist -"$SOL"`;
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
  const ranked = [...input.tweets].sort(byScoreThenId);
  const best = ranked.slice(0, BEST_LIMIT);
  const briefTerms = new Set(topicTerms(input.topic));
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
      reason: evidenceReason(tweet, index + 1, best.length, briefTerms, contentKind),
    };
  });

  const terms = aggregateTerms(
    best.map((tweet) => ({ text: tweet.text, hashtags: tweet.hashtags, viralityScore: tweet.viralityScore })),
    1,
  );
  const hashtags = (terms.hashtags.length > 0 ? terms.hashtags.map((term) => term.term) : topicTerms(input.topic)).slice(0, 3);
  const windows = optimalPostingWindowsUTC(
    best.map((tweet) => ({ createdAt: tweet.createdAt, viralityScore: tweet.viralityScore })),
    1,
  );
  const bestTimeToPostUTC = windows[0] ?? 'not enough similar posts';
  const lead = evidence[0];
  const mentions = lead && classifyInfluencerTier(lead.followers) ? [lead.authorUsername] : [];
  const title = titleFromTopic(input.topic);
  const options = buildOptions(evidence);
  const recommended = options.find((option) => option.recommended) ?? options[0];
  const contentKind = recommended?.kind ?? 'text';
  const content = recommended?.body ?? 'State the result in the first line and name the constraint in the second.';
  const mediaNote = recommended?.reason ?? 'No similar post cleared the filters.';

  const why = lead
    ? `Searched X with ${input.query}. ${input.searched} posts came back and ${input.tweets.length} stayed after spam and repost filters. The content type is ${kindLabel(contentKind)} because that format holds the most virality among the top ${evidence.length}. Hashtags are the engagement-weighted tags on those posts. ${bestTimeToPostUTC} is 30 minutes before the UTC hour where they clustered. ${lead.reason}`
    : `Searched X with ${input.query}. ${input.searched} posts came back and none stayed after the spam and repost filters. The draft is text only, from your brief. There is no format or timing evidence.`;

  return {
    topic: input.topic,
    query: input.query,
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
    kept: input.tweets.length,
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
  logger.info('advise search', { query, pool });

  const raws = await input.twitter.searchPool(query, { maxPages: input.maxPages ?? 2 });
  const tweets: AdvisedTweet[] = [];
  for (const raw of raws) {
    const normalized = normalizeTweet(raw, pool, now);
    if (!normalized) continue;
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
    `Search: \`${advice.query}\``,
    '',
    `## ${advice.title}`,
    '',
    `Content type: ${kindLabel(advice.contentKind)}`,
    '',
    advice.content,
    '',
    '## Options',
    '',
    ...advice.options.map((option) =>
      [
        `### ${option.recommended ? 'Recommended: ' : ''}${option.label}`,
        '',
        option.reason,
        '',
        option.body,
        '',
      ].join('\n'),
    ),
    `Hashtags: ${advice.hashtags.map((tag) => `#${tag}`).join(' ') || 'none'}`,
    `Mentions: ${advice.mentions.map((name) => `@${name}`).join(' ') || 'none'}`,
    `Time: ${advice.bestTimeToPostUTC} UTC`,
    '',
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
  for (const token of brief.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (token.length < 3 || PURE_NUMBER.test(token) || TOPIC_STOPWORDS.has(token) || seen.has(token)) continue;
    seen.add(token);
    terms.push(token);
  }
  return terms;
}

function titleFromTopic(topic: string): string {
  const clean = topic.replace(/\s+/g, ' ').trim();
  const sentence = clean.split(/(?<=[.!?])\s/u)[0] ?? clean;
  const chars = [...sentence];
  if (chars.length <= 90) return sentence;
  const cut = chars.slice(0, 90).join('');
  const space = cut.lastIndexOf(' ');
  return space > 40 ? cut.slice(0, space) : cut;
}

type AdvisedTweet = NormalizedTweet & { contentKind?: ContentKind };

function buildOptions(evidence: readonly AdviceEvidence[]): AdviceOption[] {
  if (evidence.length === 0) {
    return [
      {
        kind: 'text',
        label: 'Text, result first',
        body: 'State the result in the first line and name the constraint in the second.',
        recommended: true,
        reason: 'No similar post cleared the filters, so the only grounded option is a text post from your brief.',
      },
      {
        kind: 'text',
        label: 'Text, constraint first',
        body: 'Name the constraint in the first line, then the result.',
        recommended: false,
        reason: 'A second wording of the same text post. There is no media evidence to prefer GIF, video, or a still.',
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
      body: 'Lead with the concrete result, then the constraint. Skip the trailer.',
      recommended: leadKind === 'text',
      reason: textReason,
    },
    {
      kind: 'text',
      label: 'Text, constraint first',
      body: 'Name the constraint in the first line, then the result it unlocked.',
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

function formatBody(kind: ContentKind): string {
  if (kind === 'gif') return 'Attach a 1–2 second loop of the mechanic. No trailer.';
  if (kind === 'video') return 'Attach a silent clip under 15 seconds. Cut before the explanation.';
  if (kind === 'image') return 'Attach one still of the moment the mechanic reads.';
  return 'Lead with the concrete result, then the constraint.';
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
  briefTerms: ReadonlySet<string>,
  contentKind: ContentKind,
): string {
  const hour = new Date(tweet.createdAt).getUTCHours();
  const overlap = tweet.text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => briefTerms.has(token));
  const uniqueOverlap = [...new Set(overlap)];
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
