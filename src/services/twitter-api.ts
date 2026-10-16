import { z } from 'zod';
import { isRetweetText, isSpamText } from '../config/queries.js';
import type { NormalizedTweet, PoolName } from '../domain.js';
import { silentLogger, type Logger } from '../logger.js';

// Snowflake ids exceed Number.MAX_SAFE_INTEGER. String() keeps digits; Number() would round them.
const StringIdSchema = z.union([z.string(), z.number()]).transform((value) => String(value));

function countField() {
  return z.number().optional().default(0);
}

const HashtagSchema = z
  .object({
    text: z.string().optional(),
    tag: z.string().optional(),
  })
  .passthrough();

const MediaSchema = z
  .object({
    type: z.string().optional(),
  })
  .passthrough();

const PublicMetricsSchema = z
  .object({
    followers_count: z.number().optional(),
  })
  .passthrough();

const AuthorSchema = z
  .object({
    id: StringIdSchema,
    userName: z.string().optional(),
    username: z.string().optional(),
    screen_name: z.string().optional(),
    followers: z.number().optional(),
    followersCount: z.number().optional(),
    public_metrics: PublicMetricsSchema.optional(),
  })
  .passthrough();

const EntitiesSchema = z
  .object({
    hashtags: z.array(HashtagSchema).optional(),
    media: z.array(MediaSchema).optional(),
  })
  .passthrough();

const ExtendedEntitiesSchema = z
  .object({
    media: z.array(MediaSchema).optional(),
  })
  .passthrough();

export const RawTweetSchema = z
  .object({
    id: StringIdSchema,
    url: z.string().optional(),
    text: z.string(),
    retweetCount: countField(),
    replyCount: countField(),
    likeCount: countField(),
    quoteCount: countField(),
    viewCount: countField(),
    createdAt: z.string(),
    author: AuthorSchema,
    entities: EntitiesSchema.optional(),
    extendedEntities: ExtendedEntitiesSchema.optional(),
    extended_entities: ExtendedEntitiesSchema.optional(),
    retweeted_tweet: z.unknown().optional(),
  })
  .passthrough();

export const TwitterSearchResponseSchema = z
  .object({
    tweets: z.array(RawTweetSchema),
    has_next_page: z.boolean().optional().default(false),
    next_cursor: z.string().nullable().optional(),
  })
  .passthrough();

export type RawTweet = z.infer<typeof RawTweetSchema>;
export type TwitterSearchResponse = z.infer<typeof TwitterSearchResponseSchema>;

export interface TwitterApiClientOptions {
  apiKey: string;
  baseUrl: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number; // extra retries after the first try. Default 3. Total attempts = maxRetries + 1.
  logger?: Logger;
}

export interface SearchPage {
  tweets: RawTweet[];
  hasNextPage: boolean;
  nextCursor: string | null;
}

const SEARCH_PATH = '/twitter/tweet/advanced_search';

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.arrayBuffer();
  } catch {
    // Status decides the retry. A broken error body does not.
  }
}

export class TwitterApiClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly logger: Logger;

  constructor(options: TwitterApiClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.maxRetries = options.maxRetries ?? 3;
    this.logger = options.logger ?? silentLogger;
  }

  async searchRecent(query: string, cursor?: string): Promise<SearchPage> {
    const url = this.buildSearchUrl(query, cursor);
    const totalAttempts = this.maxRetries + 1;
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: 'GET',
          headers: {
            'X-API-Key': this.apiKey,
            Accept: 'application/json',
          },
        });
      } catch (error) {
        const failureCount = attempt;
        lastError = new Error(`Twitter API request failed: ${errorMessage(error)}`);
        if (failureCount > this.maxRetries) {
          this.logger.error('twitter search failed', { error: errorMessage(error) });
          throw lastError;
        }
        const delayMs = 200 * 2 ** (failureCount - 1);
        this.logger.warn('twitter search retry', { delayMs, attempt: failureCount, error: errorMessage(error) });
        await this.sleep(delayMs);
        continue;
      }

      if (isRetryableStatus(response.status)) {
        const failureCount = attempt;
        await discardBody(response);
        lastError = new Error(`Twitter API request failed with status ${response.status}`);
        if (failureCount > this.maxRetries) {
          this.logger.error('twitter search failed', { status: response.status });
          throw lastError;
        }
        const delayMs = 200 * 2 ** (failureCount - 1);
        this.logger.warn('twitter search retry', {
          delayMs,
          attempt: failureCount,
          status: response.status,
        });
        await this.sleep(delayMs);
        continue;
      }

      if (!response.ok) {
        await discardBody(response);
        this.logger.error('twitter search failed', { status: response.status });
        throw new Error(`Twitter API request failed with status ${response.status}`);
      }

      const body: unknown = await response.json();
      return toSearchPage(TwitterSearchResponseSchema.parse(body));
    }

    throw lastError ?? new Error('Twitter API request failed');
  }

  async searchPool(query: string, options?: { maxPages?: number }): Promise<RawTweet[]> {
    const maxPages = options?.maxPages ?? 5;
    const tweets: RawTweet[] = [];
    let cursor: string | undefined;

    for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
      const page = await this.searchRecent(query, cursor);
      tweets.push(...page.tweets);
      if (!page.hasNextPage || page.nextCursor === null) break;
      cursor = page.nextCursor;
    }

    return tweets;
  }

  private buildSearchUrl(query: string, cursor?: string): string {
    let url = `${this.baseUrl}${SEARCH_PATH}?query=${encodeURIComponent(query)}&queryType=Latest`;
    if (typeof cursor === 'string' && cursor.length > 0) {
      url += `&cursor=${encodeURIComponent(cursor)}`;
    }
    return url;
  }
}

function toSearchPage(parsed: TwitterSearchResponse): SearchPage {
  const nextCursor =
    typeof parsed.next_cursor === 'string' && parsed.next_cursor.length > 0 ? parsed.next_cursor : null;
  return {
    tweets: parsed.tweets,
    hasNextPage: parsed.has_next_page && nextCursor !== null,
    nextCursor,
  };
}

export function normalizeTweet(raw: RawTweet, pool: PoolName, now: Date): NormalizedTweet | null {
  const retweetPayload = raw.retweeted_tweet !== undefined && raw.retweeted_tweet !== null;
  if (isRetweetText(raw.text) || retweetPayload) return null;
  if (isSpamText(raw.text)) return null;

  const authorUsername = usernameFromAuthor(raw.author);
  if (authorUsername === null) return null;

  const created = new Date(raw.createdAt);
  if (Number.isNaN(created.getTime())) return null;

  const url =
    raw.url !== undefined && raw.url.length > 0
      ? raw.url
      : `https://x.com/${authorUsername}/status/${raw.id}`;

  return {
    id: raw.id,
    pool,
    authorId: raw.author.id,
    authorUsername,
    authorFollowers: followerCount(raw.author),
    text: raw.text,
    createdAt: created.toISOString(),
    likes: raw.likeCount,
    retweets: raw.retweetCount,
    replies: raw.replyCount,
    quotes: raw.quoteCount,
    views: raw.viewCount,
    hasMedia:
      nonEmptyMedia(raw.extendedEntities?.media) ||
      nonEmptyMedia(raw.extended_entities?.media) ||
      nonEmptyMedia(raw.entities?.media),
    hashtags: collectHashtags(raw),
    url,
    viralityScore: 0,
    ingestedAt: now.toISOString(),
  };
}

function usernameFromAuthor(author: RawTweet['author']): string | null {
  const candidate = [author.userName, author.username, author.screen_name].find(
    (value) => typeof value === 'string' && value.trim().length > 0,
  );
  if (candidate === undefined) return null;
  const stripped = candidate.trim().replace(/^@/, '');
  return stripped.length > 0 ? stripped : null;
}

function followerCount(author: RawTweet['author']): number {
  return author.followers ?? author.followersCount ?? author.public_metrics?.followers_count ?? 0;
}

function nonEmptyMedia(media: unknown): boolean {
  return Array.isArray(media) && media.length > 0;
}

function addHashtag(value: string | undefined, seen: Set<string>, hashtags: string[]): void {
  if (value === undefined) return;
  const normalized = value.trim().replace(/^#+/, '').toLowerCase();
  if (normalized.length === 0 || seen.has(normalized)) return;
  seen.add(normalized);
  hashtags.push(normalized);
}

function collectHashtags(raw: RawTweet): string[] {
  const seen = new Set<string>();
  const hashtags: string[] = [];
  for (const entry of raw.entities?.hashtags ?? []) {
    addHashtag(entry.text, seen, hashtags);
    addHashtag(entry.tag, seen, hashtags);
  }
  for (const match of raw.text.matchAll(/#([\p{L}\p{N}_]+)/gu)) {
    addHashtag(match[1], seen, hashtags);
  }
  return hashtags;
}
