import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db/client.js';
import { TweetRepository } from '../../src/db/repository.js';
import type { NormalizedTweet } from '../../src/domain.js';
import type { Database } from 'better-sqlite3';

const openDbs: Database[] = [];
const tempDirs: string[] = [];

function makeTweet(overrides: Partial<NormalizedTweet> = {}): NormalizedTweet {
  return {
    id: 'tweet-1',
    pool: 'indiedev',
    authorId: 'author-1',
    authorUsername: 'devone',
    authorFollowers: 1200,
    text: 'shipped a demo',
    createdAt: '2026-04-01T12:00:00.000Z',
    likes: 10,
    retweets: 2,
    replies: 1,
    quotes: 0,
    views: 100,
    hasMedia: true,
    hashtags: ['indiedev', 'gamedev'],
    url: 'https://x.com/devone/status/tweet-1',
    viralityScore: 4.5,
    ingestedAt: '2026-04-01T13:00:00.000Z',
    ...overrides,
  };
}

function openTemp(filename = 'xradar.db'): { db: Database; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'xradar-db-'));
  tempDirs.push(dir);
  const dbPath = join(dir, filename);
  const db = openDatabase(dbPath);
  openDbs.push(db);
  return { db, dbPath };
}

afterEach(() => {
  while (openDbs.length > 0) {
    const db = openDbs.pop();
    if (db?.open) db.close();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('TweetRepository', () => {
  it('enables WAL on a file database', () => {
    const { db } = openTemp();
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
  });

  it('updates engagement but keeps the original ingestedAt', () => {
    const { db } = openTemp();
    const repo = new TweetRepository(db);
    const first = makeTweet({ id: 'a', viralityScore: 9, likes: 3, ingestedAt: '2026-04-01T13:00:00.000Z' });
    const tied = makeTweet({
      id: 'b',
      viralityScore: 9,
      likes: 1,
      hasMedia: false,
      hashtags: [],
      ingestedAt: '2026-04-01T14:00:00.000Z',
    });

    repo.upsertTweet(first);
    repo.upsertTweet(tied);
    repo.upsertTweet({
      ...first,
      likes: 8,
      text: 'updated copy',
      hashtags: ['solana'],
      viralityScore: 9,
      ingestedAt: '2026-05-01T00:00:00.000Z',
    });

    expect(repo.countTweets()).toBe(2);
    expect(repo.getTweet('missing')).toBeNull();
    expect(repo.getTweet('a')).toEqual({
      ...first,
      likes: 8,
      text: 'updated copy',
      hashtags: ['solana'],
      ingestedAt: '2026-04-01T13:00:00.000Z',
    });
    expect(repo.listTweets().map((tweet) => tweet.id)).toEqual(['a', 'b']);
    expect(repo.getTweet('b')?.hasMedia).toBe(false);
  });

  it('treats invalid hashtags_json as an empty list', () => {
    const { db } = openTemp();
    const repo = new TweetRepository(db);
    db.prepare(
      `INSERT INTO tweets (
        id, pool, author_id, author_username, author_followers, text, created_at,
        hashtags_json, url, virality_score, ingested_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'bad-tags',
      'solana',
      'author-9',
      'spammer',
      10,
      'no tags',
      '2026-01-01T00:00:00.000Z',
      'not-json',
      'https://x.com/spammer/status/bad-tags',
      1,
      '2026-01-01T00:00:00.000Z',
    );

    const stored = repo.getTweet('bad-tags');
    expect(stored?.hashtags).toEqual([]);
    expect(stored?.hasMedia).toBe(false);
    expect(stored?.likes).toBe(0);
  });

  it('averages outlier scores per author', () => {
    const { db } = openTemp();
    const repo = new TweetRepository(db);

    const first = repo.upsertInfluencerFromOutlier({
      authorId: 'a1',
      username: 'alice',
      followers: 5000,
      tier: 'rising_star',
      viralityScore: 10,
      seenAt: '2026-05-01T00:00:00.000Z',
    });
    expect(first).toEqual({
      authorId: 'a1',
      username: 'alice',
      followers: 5000,
      tier: 'rising_star',
      avgViralityScore: 10,
      outlierHits: 1,
      lastSeenAt: '2026-05-01T00:00:00.000Z',
    });

    const second = repo.upsertInfluencerFromOutlier({
      authorId: 'a1',
      username: 'alice2',
      followers: 8000,
      tier: 'whale',
      viralityScore: 30,
      seenAt: '2026-05-02T00:00:00.000Z',
    });
    expect(second.outlierHits).toBe(2);
    expect(second.avgViralityScore).toBe(20);
    expect(second.username).toBe('alice2');
    expect(second.followers).toBe(8000);
    expect(second.tier).toBe('whale');
    expect(second.lastSeenAt).toBe('2026-05-02T00:00:00.000Z');

    const other = repo.upsertInfluencerFromOutlier({
      authorId: 'a2',
      username: 'bob',
      followers: 30000,
      tier: 'whale',
      viralityScore: 5,
      seenAt: '2026-05-03T00:00:00.000Z',
    });
    expect(other.outlierHits).toBe(1);
    expect(other.avgViralityScore).toBe(5);
    expect(repo.getInfluencer('a1')?.outlierHits).toBe(2);
    expect(repo.getInfluencer('missing')).toBeNull();
    expect(repo.listInfluencers(10).map((row) => row.authorId)).toEqual(['a1', 'a2']);
    expect(repo.listInfluencers(1).map((row) => row.authorId)).toEqual(['a1']);
  });

  it('roundtrips fetch state including a null last tweet id', () => {
    const { db } = openTemp();
    const repo = new TweetRepository(db);

    expect(repo.getFetchState('indiedev')).toBeNull();

    repo.setFetchState('indiedev', '123', '2026-03-01T00:00:00.000Z');
    expect(repo.getFetchState('indiedev')).toEqual({
      pool: 'indiedev',
      lastTweetId: '123',
      lastFetchedAt: '2026-03-01T00:00:00.000Z',
    });
    expect(repo.getFetchState('solana')).toBeNull();

    repo.setFetchState('indiedev', null, '2026-03-02T00:00:00.000Z');
    expect(repo.getFetchState('indiedev')).toEqual({
      pool: 'indiedev',
      lastTweetId: null,
      lastFetchedAt: '2026-03-02T00:00:00.000Z',
    });
  });

  it('reopens the same file without throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xradar-db-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'nested', 'xradar.db');

    const first = openDatabase(dbPath);
    openDbs.push(first);
    expect(first.pragma('journal_mode', { simple: true })).toBe('wal');
    new TweetRepository(first).upsertTweet(makeTweet());
    first.close();

    const second = openDatabase(dbPath);
    openDbs.push(second);
    expect(second.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(new TweetRepository(second).countTweets()).toBe(1);
    expect(new TweetRepository(second).getTweet('tweet-1')?.ingestedAt).toBe('2026-04-01T13:00:00.000Z');
  });
});
