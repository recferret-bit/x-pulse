import { readFile } from 'node:fs/promises';
import path from 'node:path';
import cron from 'node-cron';
import type Database from 'better-sqlite3';
import type { Env } from './config/env.js';
import { SEARCH_POOLS } from './config/queries.js';
import {
  OUTLIER_FRACTION,
  PAYLOAD_INFLUENCER_LIMIT,
  PAYLOAD_TWEET_LIMIT,
  TIMING_FRACTION,
  type GrokPayload,
  type NormalizedTweet,
  type PoolName,
} from './domain.js';
import { silentLogger, type Logger } from './logger.js';
import { loadProjectSoul } from './services/soul.js';
import { TweetRepository } from './db/repository.js';
import {
  aggregateTerms,
  calculateViralityScore,
  classifyInfluencerTier,
  optimalPostingWindowsUTC,
  selectTopFraction,
} from './services/scorer.js';
import {
  GrokAnalysisSchema,
  GrokRunner,
  type GrokAnalysisResult,
} from './services/grok-runner.js';
import { explainSelection, renderExplanationPlain } from './services/selection-reasons.js';
import { TelegramNotifier } from './services/telegram-notifier.js';
import { TwitterApiClient, normalizeTweet } from './services/twitter-api.js';

export interface PipelineDeps {
  env: Env;
  db: Database.Database;
  twitter: TwitterApiClient;
  repository: TweetRepository;
  grok: GrokRunner;
  telegram: TelegramNotifier;
  now?: Date;
  logger?: Logger;
  maxPages?: number;
}

export interface IngestResult {
  fetched: number;
  stored: number;
  filtered: number;
  outliers: number;
  influencersUpserted: number;
}

interface PoolCursor {
  pool: PoolName;
  previousLastId: string | null;
  maxId: string | null;
}

export async function ingest(deps: PipelineDeps): Promise<IngestResult> {
  const now = deps.now ?? new Date();
  const logger = deps.logger ?? silentLogger;
  const repository = deps.repository;
  const seenAt = now.toISOString();
  const unique = new Map<string, NormalizedTweet>();
  const cursors: PoolCursor[] = [];
  let fetched = 0;
  let filtered = 0;

  logger.info('ingest started', { at: seenAt });

  for (const pool of SEARCH_POOLS) {
    const previous = repository.getFetchState(pool.name);
    const previousLastId = previous?.lastTweetId ?? null;
    const query = previousLastId ? `${pool.query} since_id:${previousLastId}` : pool.query;
    const raws = await deps.twitter.searchPool(query, { maxPages: deps.maxPages ?? 5 });
    fetched += raws.length;

    let maxId: string | null = null;
    for (const raw of raws) {
      maxId = preferNumericId(maxId, rawTweetId(raw));
      const normalized = normalizeTweet(raw, pool.name, now);
      if (!normalized) {
        filtered += 1;
        continue;
      }
      const existing = unique.get(normalized.id);
      if (!existing) {
        unique.set(normalized.id, normalized);
      } else if (pool.name === 'intersection') {
        unique.set(normalized.id, { ...existing, pool: 'intersection' });
      }
    }

    cursors.push({ pool: pool.name, previousLastId, maxId });
    logger.info('fetched pool', { pool: pool.name, raw: raws.length });
  }

  const scored: NormalizedTweet[] = [];
  for (const tweet of unique.values()) {
    scored.push({
      ...tweet,
      viralityScore: calculateViralityScore(
        {
          likes: tweet.likes,
          retweets: tweet.retweets,
          replies: tweet.replies,
          quotes: tweet.quotes,
          authorFollowers: tweet.authorFollowers,
          createdAt: tweet.createdAt,
        },
        now,
      ),
    });
  }

  const outliers = selectTopFraction(scored, (tweet) => tweet.viralityScore, OUTLIER_FRACTION);
  for (const tweet of scored) {
    repository.upsertTweet(tweet);
  }

  let influencersUpserted = 0;
  for (const tweet of outliers) {
    const tier = classifyInfluencerTier(tweet.authorFollowers);
    if (!tier) continue;
    repository.upsertInfluencerFromOutlier({
      authorId: tweet.authorId,
      username: tweet.authorUsername,
      followers: tweet.authorFollowers,
      tier,
      viralityScore: tweet.viralityScore,
      seenAt,
    });
    influencersUpserted += 1;
  }

  for (const cursor of cursors) {
    repository.setFetchState(cursor.pool, cursor.maxId ?? cursor.previousLastId, seenAt);
  }

  const result: IngestResult = {
    fetched,
    stored: scored.length,
    filtered,
    outliers: outliers.length,
    influencersUpserted,
  };
  logger.info('ingest finished', { ...result });
  return result;
}

export async function analyze(deps: PipelineDeps): Promise<GrokAnalysisResult> {
  const now = deps.now ?? new Date();
  const tweets = deps.repository.listTweets();
  const windows = optimalPostingWindowsUTC(
    tweets.map((tweet) => ({ createdAt: tweet.createdAt, viralityScore: tweet.viralityScore })),
    TIMING_FRACTION,
  );
  const termStats = aggregateTerms(
    tweets.map((tweet) => ({
      text: tweet.text,
      hashtags: tweet.hashtags,
      viralityScore: tweet.viralityScore,
    })),
    TIMING_FRACTION,
  );
  const outlierTweets = [...tweets]
    .sort(compareByViralityThenId)
    .slice(0, PAYLOAD_TWEET_LIMIT);
  const influencers = deps.repository.listInfluencers(PAYLOAD_INFLUENCER_LIMIT);
  const soul = await loadProjectSoul(deps.env.GROK_WORKSPACE_DIR);
  const payload: GrokPayload = {
    generatedAt: now.toISOString(),
    optimalPostingWindowsUTC: windows,
    termStats,
    outlierTweets,
    influencers,
    ...(soul
      ? {
          projectSoul: {
            name: soul.name,
            what: soul.what,
            mood: soul.mood,
            style: soul.style,
            never: soul.never,
            audience: soul.audience,
            seek: soul.seek,
            title: soul.title,
            launch: soul.launch,
            constraint: soul.constraint,
          },
        }
      : {}),
  };
  const result = await deps.grok.analyze(payload);
  const selection = renderExplanationPlain(explainSelection({ tweets, influencers, analysis: result }));
  await deps.telegram.sendDigest(result, {
    optimalPostingWindowsUTC: windows,
    generatedAt: payload.generatedAt,
    selectionSummary: withSoul(soul, selection),
  });
  return result;
}

export async function runOnce(deps: PipelineDeps): Promise<GrokAnalysisResult> {
  const now = deps.now;
  await ingest({ ...deps, now });
  return analyze({ ...deps, now });
}

export async function notify(deps: PipelineDeps): Promise<{ skipped: boolean; sent: number }> {
  const outputPath = path.join(deps.env.GROK_WORKSPACE_DIR, 'output_latest.json');
  const raw = await readFile(outputPath, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  const analysis = GrokAnalysisSchema.parse(parsed);
  const context = await readDigestContext(deps.env.GROK_WORKSPACE_DIR);
  const tweets = deps.repository.listTweets();
  const influencers = deps.repository.listInfluencers(PAYLOAD_INFLUENCER_LIMIT);
  return deps.telegram.sendDigest(analysis, {
    ...context,
    selectionSummary: withSoul(await loadProjectSoul(deps.env.GROK_WORKSPACE_DIR), renderExplanationPlain(explainSelection({ tweets, influencers, analysis }))),
  });
}

function withSoul(soul: Awaited<ReturnType<typeof loadProjectSoul>>, selection: string): string {
  if (!soul) return selection;
  const voice = [`Voice: ${[soul.mood, soul.style].filter((part) => part.length > 0).join(' ')}`, soul.audience.length > 0 ? `Aimed at: ${soul.audience.join('; ')}.` : '']
    .filter((part) => part.length > 0)
    .join('\n\n');
  return [voice, selection].filter((part) => part.length > 0).join('\n\n');
}

/** Minute 0 of every third UTC hour: 00, 03, 06, 09, 12, 15, 18, 21. */
export const INGEST_CRON = '0 */3 * * *';

/**
 * 08:00 and 17:00 UTC. These hours are not on the 3-hour grid, so this job
 * does not fire at the same time as INGEST_CRON.
 */
export const DIGEST_CRON = '0 8,17 * * *';

export function startDaemon(deps: PipelineDeps): { stop(): void } {
  const logger = deps.logger ?? silentLogger;
  logger.info('daemon starting');
  let inProgress = false;

  const runGuarded = (label: string, job: () => Promise<unknown>): void => {
    if (inProgress) {
      logger.warn('pipeline run already in progress; skipping', { label });
      return;
    }
    inProgress = true;
    void (async () => {
      try {
        await job();
      } catch (error) {
        logger.error('scheduled pipeline run failed', { label, error: errorText(error) });
      } finally {
        inProgress = false;
      }
    })();
  };

  const ingestTask = cron.schedule(
    INGEST_CRON,
    () => {
      runGuarded('ingest', () => ingest(deps));
    },
    { timezone: 'UTC' },
  );

  const digestTask = cron.schedule(
    DIGEST_CRON,
    () => {
      runGuarded('digest', () => runOnce(deps));
    },
    { timezone: 'UTC' },
  );

  return {
    stop() {
      ingestTask.stop();
      digestTask.stop();
    },
  };
}

async function readDigestContext(workspaceDir: string): Promise<{
  optimalPostingWindowsUTC: string[];
  generatedAt: string;
}> {
  const generatedAt = new Date().toISOString();
  const payloadPath = path.join(workspaceDir, 'payload_latest.json');
  let raw: string;
  try {
    raw = await readFile(payloadPath, 'utf8');
  } catch (error) {
    if (isEnoent(error)) return { optimalPostingWindowsUTC: [], generatedAt };
    throw error;
  }

  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) {
    return { optimalPostingWindowsUTC: [], generatedAt };
  }
  const record = parsed as Record<string, unknown>;
  const windows = isStringArray(record.optimalPostingWindowsUTC)
    ? record.optimalPostingWindowsUTC
    : [];
  return {
    optimalPostingWindowsUTC: windows,
    generatedAt: typeof record.generatedAt === 'string' ? record.generatedAt : generatedAt,
  };
}

function compareByViralityThenId(a: NormalizedTweet, b: NormalizedTweet): number {
  if (a.viralityScore !== b.viralityScore) return b.viralityScore - a.viralityScore;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

function rawTweetId(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null || !('id' in raw)) return null;
  const id = (raw as { id: unknown }).id;
  if (typeof id === 'string') return id;
  if (typeof id === 'number' && Number.isSafeInteger(id) && id >= 0) return String(id);
  return null;
}

function preferNumericId(current: string | null, candidate: string | null): string | null {
  if (candidate === null || !/^\d+$/.test(candidate)) return current;
  if (current === null) return candidate;
  return BigInt(candidate) > BigInt(current) ? candidate : current;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
