import { OUTLIER_FRACTION, TIMING_FRACTION, type Influencer, type NormalizedTweet } from '../domain.js';
import type { GrokAnalysisResult } from './grok-runner.js';
import { buildTimingProfile, selectTopFraction } from './scorer.js';

export interface SelectionExplanation {
  scoringRule: string;
  filterRule: string;
  cutoff: number;
  kept: AccountPick[];
  passedOver: string | null;
  windowRule: string;
  windows: WindowPick[];
  drafts: ItemReason[];
  replies: ItemReason[];
}

export interface AccountPick {
  username: string;
  tweetId: string;
  tier: Influencer['tier'];
  reason: string;
}

export interface WindowPick {
  label: string;
  reason: string;
}

export interface ItemReason {
  title: string;
  reason: string;
}

export interface PublishablePost {
  label: string;
  text: string;
  url: string;
  reason?: string;
}

const SCORING_RULE =
  'Virality = (likes + 2×retweets + 3×replies + 4×quotes) / max(followers, 100) / (hours since posted + 2)^1.5 × 1000. A higher score means more engagement per follower while the post is still fresh. The watchlist is the top 15% of that score, and only when the author has at least 1,000 followers.';

const FILTER_RULE =
  'Posts are dropped before scoring when the text contains a spam term (airdrop, giveaway, pump, presale, whitelist, or $SOL) or when the text is a repost starting with "RT @". Dropped posts never compete for the top 15%.';

const WINDOW_RULE =
  'The clock uses the top 20% of stored posts by virality. Their scores are summed into the UTC hour they were published. The post time is that peak hour minus 30 minutes, so the post goes out as the hour starts to build. At most three hours are kept, highest weight first.';

export function explainSelection(input: {
  tweets: readonly NormalizedTweet[];
  influencers: readonly Influencer[];
  analysis: GrokAnalysisResult;
}): SelectionExplanation {
  const sorted = [...input.tweets].sort(byScoreThenId);
  const outliers = selectTopFraction(sorted, (tweet) => tweet.viralityScore, OUTLIER_FRACTION);
  const outlierIds = new Set(outliers.map((tweet) => tweet.id));
  const cutoff = outliers.length === 0 ? 0 : Math.min(...outliers.map((tweet) => tweet.viralityScore));
  const rankById = new Map(sorted.map((tweet, index) => [tweet.id, index + 1]));
  const tweetById = new Map(sorted.map((tweet) => [tweet.id, tweet]));
  const bestByAuthor = new Map<string, NormalizedTweet>();
  for (const tweet of sorted) {
    const current = bestByAuthor.get(tweet.authorId);
    if (!current || tweet.viralityScore > current.viralityScore) bestByAuthor.set(tweet.authorId, tweet);
  }

  const kept: AccountPick[] = [];
  for (const influencer of input.influencers) {
    const tweet = bestByAuthor.get(influencer.authorId);
    if (!tweet || !outlierIds.has(tweet.id)) continue;
    const rank = rankById.get(tweet.id) ?? 0;
    kept.push({
      username: influencer.username,
      tweetId: tweet.id,
      tier: influencer.tier,
      reason: accountReason(influencer, tweet, rank, sorted.length, cutoff),
    });
  }

  const passedOverTweet = sorted.find((tweet) => !outlierIds.has(tweet.id));
  const passedOver = passedOverTweet
    ? `@${passedOverTweet.authorUsername} (${passedOverTweet.id}) is the first post under the cutoff, at ${formatScore(passedOverTweet.viralityScore)} against ${formatScore(cutoff)}. It stays in the archive and off the watchlist.`
    : null;

  const profile = buildTimingProfile(
    sorted.map((tweet) => ({ createdAt: tweet.createdAt, viralityScore: tweet.viralityScore })),
    TIMING_FRACTION,
  );
  const windows = profile.optimalPostingWindowsUTC.map((label) => ({
    label,
    reason: windowReason(label, profile.hourWeights),
  }));
  const measured = windows.map((window) => window.label).join(', ') || 'none';

  const drafts = input.analysis.postDrafts.map((draft, index) => {
    const trend = input.analysis.trends[index];
    return {
      title: draft.hook,
      reason: draftReason(draft, trend, measured, input.influencers),
    };
  });

  const replies = input.analysis.replyTargets.map((target) => {
    const tweet = tweetById.get(target.tweetId);
    const selected = tweet !== undefined && outlierIds.has(tweet.id);
    return {
      title: `@${stripAt(target.authorUsername)} · ${target.tweetId}`,
      reason: replyReason(target, tweet, selected, rankById, sorted.length, cutoff),
    };
  });

  return {
    scoringRule: SCORING_RULE,
    filterRule: FILTER_RULE,
    cutoff,
    kept,
    passedOver,
    windowRule: WINDOW_RULE,
    windows,
    drafts,
    replies,
  };
}

export function renderExplanationPlain(explanation: SelectionExplanation): string {
  const lines = [explanation.scoringRule, explanation.filterRule, 'Watchlist:'];
  if (explanation.kept.length === 0) {
    lines.push('No account cleared both the top 15% and a follower tier.');
  }
  for (const account of explanation.kept) {
    lines.push(`• @${account.username} (${account.tier}): ${account.reason}`);
  }
  if (explanation.passedOver) lines.push(explanation.passedOver);
  lines.push(explanation.windowRule);
  if (explanation.windows.length === 0) lines.push('No hour carried weight, so there is no measured window.');
  for (const window of explanation.windows) lines.push(`• ${window.label}: ${window.reason}`);
  const playbookOnly = explanation.replies.filter((reply) => reply.reason.includes('The scorer did not')).length;
  lines.push(
    `Drafts are the analyst playbook, each paired with the trend in the same position. ${playbookOnly} reply targets are playbook-only because those posts sit under the top 15% cutoff.`,
  );
  return lines.join('\n');
}

export function renderReadyToPostReport(posts: readonly PublishablePost[], explanation: SelectionExplanation): string {
  const why = [
    '## Why these were selected',
    '',
    explanation.scoringRule,
    '',
    explanation.filterRule,
    '',
    '### Watchlist',
    '',
    ...explanation.kept.map((account) => `- @${account.username} (${account.tier}, ${account.tweetId}): ${account.reason}`),
    ...(explanation.passedOver ? ['', explanation.passedOver] : []),
    '',
    '### Posting window',
    '',
    explanation.windowRule,
    '',
    ...explanation.windows.map((window) => `- ${window.label}: ${window.reason}`),
    '',
  ];
  const sections = posts.map((post) =>
    [`## ${post.label}`, '', post.reason ? `Why: ${post.reason}` : '', '', post.text, '', post.url, ''].join('\n'),
  );
  return [
    '# Posts ready for X',
    '',
    'Generated by `npm test` from mocked tweets and a mocked Telegram API.',
    'Each link opens the X composer with the text filled in.',
    '',
    ...why,
    ...sections,
  ].join('\n');
}

function accountReason(
  influencer: Influencer,
  tweet: NormalizedTweet,
  rank: number,
  total: number,
  cutoff: number,
): string {
  return `Post ${tweet.id} ranked ${rank} of ${total} with virality ${formatScore(tweet.viralityScore)}. The top 15% cutoff is ${formatScore(cutoff)}, and this post is on that side of the line. It earned the score with ${tweet.likes} likes, ${tweet.retweets} reposts, ${tweet.replies} replies, and ${tweet.quotes} quotes. ${tierClause(influencer.tier, influencer.followers)}.`;
}

function tierClause(tier: Influencer['tier'], followers: number): string {
  if (tier === 'rising_star') {
    return `${followers} followers are inside 1,000–25,000, so the tier is rising_star: a direct reply is the intended move`;
  }
  return `${followers} followers are above 25,000, so the tier is whale: the intended move is a fast reply while the post is still new`;
}

function windowReason(label: string, hourWeights: readonly number[]): string {
  const peak = peakHour(label);
  const weight = hourWeights[peak] ?? 0;
  return `UTC hour ${peak} holds weight ${formatScore(weight)} from the top 20%. ${label} is that hour minus 30 minutes.`;
}

function draftReason(
  draft: GrokAnalysisResult['postDrafts'][number],
  trend: GrokAnalysisResult['trends'][number] | undefined,
  measuredWindow: string,
  influencers: readonly Influencer[],
): string {
  const names = new Set(influencers.map((influencer) => influencer.username.toLowerCase()));
  const mentions = draft.accountsToMention.map(stripAt).filter((name) => name.length > 0);
  const onWatchlist = mentions.filter((name) => names.has(name.toLowerCase()));
  const mentionClause =
    onWatchlist.length > 0
      ? `It names @${onWatchlist.join(', @')}, ${onWatchlist.length === 1 ? 'an account' : 'accounts'} the scorer placed on the watchlist.`
      : 'It does not name a watchlist account.';
  const analystReason = trend
    ? trend.whyItWorked.replace(/[. ]+$/, '')
    : '';
  const trendClause = trend
    ? `Paired with the ${trend.pool} trend "${trend.topic}". Analyst reason: ${analystReason}.`
    : 'No trend shares this draft’s position in the analyst output.';
  return `${trendClause} ${mentionClause} The playbook clock is ${draft.bestTimeToPostUTC}. The measured window from this batch is ${measuredWindow}.`;
}

function replyReason(
  target: GrokAnalysisResult['replyTargets'][number],
  tweet: NormalizedTweet | undefined,
  selected: boolean,
  rankById: ReadonlyMap<string, number>,
  total: number,
  cutoff: number,
): string {
  const username = stripAt(target.authorUsername);
  if (!tweet) {
    return `@${username} is in the analyst reply list only. Tweet ${target.tweetId} is not in the stored batch, so the scorer had no score for it. The reply text is the analyst’s technical line.`;
  }
  const rank = rankById.get(tweet.id) ?? 0;
  if (selected) {
    return `The scorer selected @${username} because tweet ${tweet.id} ranked ${rank} of ${total} (virality ${formatScore(tweet.viralityScore)}, cutoff ${formatScore(cutoff)}) and the tier on the reply is ${target.tier}. The reply text is the analyst’s technical line for that post.`;
  }
  return `The analyst playbook listed @${username}. The scorer did not. Tweet ${tweet.id} ranked ${rank} of ${total} at ${formatScore(tweet.viralityScore)}, under the top 15% cutoff of ${formatScore(cutoff)}. The reply text is the analyst’s technical line, not a scored field.`;
}

function peakHour(label: string): number {
  const hour = Number(label.slice(0, 2));
  if (!Number.isInteger(hour)) return 0;
  return (hour + 1) % 24;
}

function byScoreThenId(a: NormalizedTweet, b: NormalizedTweet): number {
  if (a.viralityScore !== b.viralityScore) return b.viralityScore - a.viralityScore;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

function stripAt(username: string): string {
  return username.trim().replace(/^@+/, '');
}

function formatScore(score: number): string {
  if (!Number.isFinite(score)) return '0';
  const absolute = Math.abs(score);
  if (absolute === 0) return '0';
  if (absolute >= 0.01) return score.toFixed(3);
  return score.toPrecision(3);
}
