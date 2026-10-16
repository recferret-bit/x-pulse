export interface ViralityInput {
  likes: number;
  retweets: number;
  replies: number;
  quotes: number;
  authorFollowers: number;
  createdAt: string | Date;
}

export function calculateViralityScore(tweet: ViralityInput, now: Date): number {
  const created = parseCreatedAt(tweet.createdAt);
  if (created === null) {
    throw new Error('Invalid tweet createdAt');
  }
  const hours = Math.max(0, (now.getTime() - created.getTime()) / 3_600_000);
  const engagement = tweet.likes + tweet.retweets * 2 + tweet.replies * 3 + tweet.quotes * 4;
  const followers = Math.max(tweet.authorFollowers, 100);
  return (engagement / followers) * (1 / (hours + 2) ** 1.5) * 1000;
}

export function classifyInfluencerTier(followers: number): 'rising_star' | 'whale' | null {
  if (followers >= 1000 && followers <= 25_000) return 'rising_star';
  if (followers > 25_000) return 'whale';
  return null;
}

export function selectTopFraction<T>(
  items: readonly T[],
  scoreOf: (item: T) => number,
  fraction: number,
): T[] {
  if (items.length === 0) return [];
  const sorted = [...items].sort((a, b) => scoreOf(b) - scoreOf(a));
  const count = Math.min(items.length, Math.max(1, Math.ceil(items.length * fraction)));
  const cutoff = scoreOf(sorted[count - 1] as T);
  return sorted.filter((item) => scoreOf(item) >= cutoff - 1e-9);
}

export interface TimedTweet {
  createdAt: string | Date;
  viralityScore: number;
}

export interface TimingProfile {
  optimalPostingWindowsUTC: string[];
  hourWeights: number[]; // length 24
  dayHourWeights: number[][]; // [7][24], Sunday = 0 via Date.getUTCDay()
}

export function buildTimingProfile(tweets: readonly TimedTweet[], topFraction?: number): TimingProfile {
  const selected = selectTopFraction(tweets, (tweet) => tweet.viralityScore, topFraction ?? 0.2);
  const hourWeights = Array.from({ length: 24 }, () => 0);
  const dayHourWeights = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));

  for (const tweet of selected) {
    const created = parseCreatedAt(tweet.createdAt);
    if (created === null) continue;
    const day = created.getUTCDay();
    const hour = created.getUTCHours();
    hourWeights[hour] = (hourWeights[hour] ?? 0) + tweet.viralityScore;
    const dayRow = dayHourWeights[day];
    if (dayRow) dayRow[hour] = (dayRow[hour] ?? 0) + tweet.viralityScore;
  }

  const optimalPostingWindowsUTC = hourWeights
    .map((weight, hour) => ({ hour, weight }))
    .filter((entry) => entry.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.hour - b.hour)
    .slice(0, 3)
    .map((entry) => formatPostingWindow(entry.hour));

  return { optimalPostingWindowsUTC, hourWeights, dayHourWeights };
}

export function optimalPostingWindowsUTC(tweets: readonly TimedTweet[], topFraction?: number): string[] {
  return buildTimingProfile(tweets, topFraction).optimalPostingWindowsUTC;
}

export interface TermTweet {
  text: string;
  hashtags: readonly string[];
  viralityScore: number;
}

export interface TermWeight {
  term: string;
  weight: number;
}

const STOPWORDS: ReadonlySet<string> = new Set([
  'the',
  'a',
  'an',
  'of',
  'to',
  'and',
  'in',
  'on',
  'for',
  'is',
  'it',
  'this',
  'that',
  'with',
  'from',
  'at',
  'by',
  'or',
  'be',
  'as',
  'are',
  'was',
  'if',
  'we',
  'you',
  'your',
  'our',
]);

const NON_WORD = /[^\p{L}\p{N}]+/gu;
const PURE_NUMBER = /^\p{N}+$/u;

export function aggregateTerms(
  tweets: readonly TermTweet[],
  topFraction?: number,
): { hashtags: TermWeight[]; ngrams: TermWeight[] } {
  const selected = selectTopFraction(tweets, (tweet) => tweet.viralityScore, topFraction ?? 0.2);
  const hashtagWeights = new Map<string, number>();
  const ngramWeights = new Map<string, number>();

  for (const tweet of selected) {
    const seenHashtags = new Set<string>();
    for (const raw of tweet.hashtags) {
      const term = normalizeHashtag(raw);
      if (term.length === 0 || seenHashtags.has(term)) continue;
      seenHashtags.add(term);
      hashtagWeights.set(term, (hashtagWeights.get(term) ?? 0) + tweet.viralityScore);
    }

    const tokens = tokenize(tweet.text);
    const seenNgrams = new Set<string>();
    for (let i = 0; i < tokens.length - 1; i += 1) {
      const left = tokens[i];
      const right = tokens[i + 1];
      if (left === undefined || right === undefined) continue;
      const term = `${left} ${right}`;
      if (seenNgrams.has(term)) continue;
      seenNgrams.add(term);
      ngramWeights.set(term, (ngramWeights.get(term) ?? 0) + tweet.viralityScore);
    }
  }

  return {
    hashtags: topTerms(hashtagWeights),
    ngrams: topTerms(ngramWeights),
  };
}

function parseCreatedAt(createdAt: string | Date): Date | null {
  const created = createdAt instanceof Date ? createdAt : new Date(createdAt);
  if (Number.isNaN(created.getTime())) return null;
  return created;
}

function formatPostingWindow(hour: number): string {
  const startHour = (hour + 23) % 24;
  return `${String(startHour).padStart(2, '0')}:30`;
}

function normalizeHashtag(raw: string): string {
  const lower = raw.toLowerCase();
  return lower.startsWith('#') ? lower.slice(1) : lower;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(NON_WORD, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 2 && !PURE_NUMBER.test(token) && !STOPWORDS.has(token));
}

function topTerms(weights: Map<string, number>): TermWeight[] {
  return [...weights.entries()]
    .map(([term, weight]) => ({ term, weight }))
    .sort((a, b) => b.weight - a.weight || (a.term < b.term ? -1 : a.term > b.term ? 1 : 0))
    .slice(0, 10);
}
