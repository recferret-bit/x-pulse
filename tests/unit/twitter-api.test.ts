import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SEARCH_POOLS } from '../../src/config/queries.js';
import { loadTwitterFixture, startMockTwitterServer } from '../../src/harness/mock-twitter-server.js';
import {
  TwitterApiClient,
  TwitterSearchResponseSchema,
  normalizeTweet,
  type RawTweet,
} from '../../src/services/twitter-api.js';
import type { PoolName } from '../../src/domain.js';

const FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures/twitter_search_sample.json',
);

const NOW = new Date('2026-04-16T12:00:00.000Z');

function poolQuery(name: PoolName): string {
  const pool = SEARCH_POOLS.find((entry) => entry.name === name);
  if (pool === undefined) throw new Error(`missing pool ${name}`);
  return pool.query;
}

function parseTweets(page: { tweets: unknown[] }): RawTweet[] {
  return TwitterSearchResponseSchema.parse({
    tweets: page.tweets,
    has_next_page: false,
    next_cursor: '',
  }).tweets;
}

function rawTweet(id: string | number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    text: `hello ${String(id)}`,
    createdAt: '2026-04-15T10:00:00.000Z',
    author: { id: '7', userName: 'ada', followers: 10 },
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      reject(error);
    };
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', onError);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('failed to bind test server'));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

describe('mock twitter server', () => {
  it('serves each search pool and rejects a missing api key', async () => {
    const fixture = loadTwitterFixture(FIXTURE_PATH);
    const server = await startMockTwitterServer(fixture);
    const indiedevQuery = poolQuery('indiedev');
    const solanaQuery = poolQuery('solana');
    const intersectionQuery = poolQuery('intersection');
    try {
      expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(solanaQuery).toContain('min_faves:40');
      expect(intersectionQuery).toContain('multiplayer backend');

      const client = new TwitterApiClient({
        apiKey: 'mock_key',
        baseUrl: server.url,
        sleep: async () => {},
      });

      const indiedevPage = await client.searchRecent(indiedevQuery);
      expect(indiedevPage.hasNextPage).toBe(false);
      expect(indiedevPage.nextCursor).toBeNull();

      const indiedev = await client.searchPool(indiedevQuery);
      const solana = await client.searchPool(solanaQuery);
      const intersection = await client.searchPool(intersectionQuery);

      expect(indiedev).toEqual(fixture.indiedev.tweets);
      expect(solana).toEqual(fixture.solana.tweets);
      expect(intersection).toEqual(fixture.intersection.tweets);
      expect(indiedev.map((tweet) => tweet.id)).toContain('9001992');
      expect(solana.map((tweet) => tweet.id)).toContain('9001991');

      const missingKey = await fetch(
        `${server.url}/twitter/tweet/advanced_search?query=${encodeURIComponent('hello')}&queryType=Latest`,
      );
      expect(missingKey.status).toBe(401);
      expect(await missingKey.json()).toEqual({ error: 'missing api key' });

      const blankKey = await fetch(`${server.url}/twitter/tweet/advanced_search?query=hello`, {
        headers: { 'X-API-Key': '   ' },
      });
      expect(blankKey.status).toBe(401);
      expect(await blankKey.json()).toEqual({ error: 'missing api key' });

      const otherPath = await fetch(`${server.url}/twitter/tweet/search`);
      expect(otherPath.status).toBe(404);
    } finally {
      await server.close();
    }
  });
});

describe('normalizeTweet', () => {
  it('drops fixture spam and retweets and maps 9001001', () => {
    const fixture = loadTwitterFixture(FIXTURE_PATH);
    const pages: Array<{ pool: PoolName; tweets: RawTweet[] }> = [
      { pool: 'indiedev', tweets: parseTweets(fixture.indiedev) },
      { pool: 'solana', tweets: parseTweets(fixture.solana) },
      { pool: 'intersection', tweets: parseTweets(fixture.intersection) },
    ];

    const dropped: string[] = [];
    const kept: string[] = [];
    let pixel: ReturnType<typeof normalizeTweet> = null;
    for (const page of pages) {
      for (const tweet of page.tweets) {
        const normalized = normalizeTweet(tweet, page.pool, NOW);
        if (normalized === null) {
          dropped.push(tweet.id);
          continue;
        }
        kept.push(normalized.id);
        if (normalized.id === '9001001') pixel = normalized;
      }
    }

    expect(dropped).toEqual(['9001992', '9001993', '9001991']);
    expect(kept).not.toContain('9001991');
    expect(kept).not.toContain('9001992');
    expect(kept).not.toContain('9001993');
    expect(pixel).toMatchObject({
      id: '9001001',
      pool: 'indiedev',
      authorId: '501',
      authorUsername: 'pixelwitch',
      authorFollowers: 2000,
      hasMedia: true,
      hashtags: ['indiedev', 'gamedev'],
      likes: 200,
      url: 'https://x.com/pixelwitch/status/9001001',
      viralityScore: 0,
      createdAt: '2026-04-15T10:00:00.000Z',
      ingestedAt: '2026-04-16T12:00:00.000Z',
    });
    expect(typeof pixel?.id).toBe('string');
  });

  it('accepts alternate author fields, twitter dates, and exact string ids', () => {
    const snowflake = '9007199254740993';
    const parsed = parseTweets({
      tweets: [
        rawTweet(9001001, {
          text: 'see #Café and #IndieDev',
          url: '',
          createdAt: 'Tue Dec 10 07:00:30 +0000 2024',
          author: {
            id: 501,
            userName: '',
            username: '@pixelwitch',
            screen_name: 'ignored',
            followers: 0,
            followersCount: 15,
            public_metrics: { followers_count: 99 },
          },
          entities: {
            hashtags: [{ text: 'IndieDev' }, { text: 'Alpha', tag: 'Beta' }],
            media: [{ type: 'photo' }],
          },
        }),
        rawTweet(snowflake, {
          text: 'no hash',
          url: undefined,
          author: {
            id: snowflake,
            screen_name: '@snow',
            public_metrics: { followers_count: 3 },
          },
          extended_entities: { media: [{ type: 'video' }] },
        }),
        rawTweet('1', {
          text: 'quoted #Extra',
          author: { id: '2', userName: 'quoted' },
          retweeted_tweet: { id: '9' },
        }),
        rawTweet('2', {
          text: 'still original',
          author: { id: '3', userName: 'kept' },
          retweeted_tweet: null,
          extendedEntities: { media: [] },
        }),
        rawTweet('3', {
          text: 'undated',
          createdAt: 'not-a-date',
          author: { id: '4', userName: 'ghost' },
        }),
        rawTweet('4', {
          text: 'anonymous',
          author: { id: '5' },
        }),
      ],
    });

    const [alternate, snow, quoted, kept, undated, anonymous] = parsed;
    if (!alternate || !snow || !quoted || !kept || !undated || !anonymous) {
      throw new Error('expected parsed tweets');
    }

    expect(normalizeTweet(alternate, 'solana', NOW)).toMatchObject({
      id: '9001001',
      authorId: '501',
      authorUsername: 'pixelwitch',
      authorFollowers: 0,
      pool: 'solana',
      createdAt: '2024-12-10T07:00:30.000Z',
      hasMedia: true,
      hashtags: ['indiedev', 'alpha', 'beta', 'café'],
      url: 'https://x.com/pixelwitch/status/9001001',
      viralityScore: 0,
      likes: 0,
    });
    expect(normalizeTweet(snow, 'indiedev', NOW)).toMatchObject({
      id: snowflake,
      authorId: snowflake,
      authorUsername: 'snow',
      authorFollowers: 3,
      hasMedia: true,
      url: `https://x.com/snow/status/${snowflake}`,
    });
    expect(normalizeTweet(quoted, 'indiedev', NOW)).toBeNull();
    expect(normalizeTweet(kept, 'indiedev', NOW)?.hasMedia).toBe(false);
    expect(normalizeTweet(undated, 'indiedev', NOW)).toBeNull();
    expect(normalizeTweet(anonymous, 'indiedev', NOW)).toBeNull();
  });
});

describe('TwitterApiClient retries', () => {
  it('backs off on the first two 500s and then returns the tweet', async () => {
    let hits = 0;
    const server = createServer((_req, res) => {
      hits += 1;
      if (hits <= 2) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unavailable' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          tweets: [rawTweet('4242', { text: 'recovered' })],
          has_next_page: false,
          next_cursor: '',
        }),
      );
    });

    const delays: number[] = [];
    try {
      const baseUrl = await listen(server);
      const client = new TwitterApiClient({
        apiKey: 'mock_key',
        baseUrl,
        maxRetries: 3,
        sleep: async (ms) => {
          delays.push(ms);
        },
      });
      const page = await client.searchRecent('hello');
      expect(delays).toEqual([200, 400]);
      expect(hits).toBe(3);
      expect(page.tweets).toHaveLength(1);
      expect(page.tweets[0]?.id).toBe('4242');
      expect(page.hasNextPage).toBe(false);
      expect(page.nextCursor).toBeNull();
    } finally {
      await closeServer(server);
    }
  });

  it('does not retry a 400', async () => {
    let hits = 0;
    const server = createServer((_req, res) => {
      hits += 1;
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad query' }));
    });

    const delays: number[] = [];
    try {
      const baseUrl = await listen(server);
      const client = new TwitterApiClient({
        apiKey: 'mock_key',
        baseUrl,
        maxRetries: 3,
        sleep: async (ms) => {
          delays.push(ms);
        },
      });
      await expect(client.searchRecent('hello')).rejects.toThrow(/status 400/);
      expect(delays).toEqual([]);
      expect(hits).toBe(1);
    } finally {
      await closeServer(server);
    }
  });

  it('retries network errors and includes the last error message', async () => {
    let hits = 0;
    const delays: number[] = [];
    const fetchImpl: typeof fetch = async () => {
      hits += 1;
      throw new Error('socket hang up');
    };
    const client = new TwitterApiClient({
      apiKey: 'mock_key',
      baseUrl: 'https://api.example.com',
      fetchImpl,
      maxRetries: 3,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });

    await expect(client.searchRecent('hello')).rejects.toThrow(/socket hang up/);
    expect(delays).toEqual([200, 400, 800]);
    expect(hits).toBe(4);
  });

  it('follows cursors, caps pages, and encodes the query', async () => {
    const urls: string[] = [];
    const headersSeen: Array<Record<string, string>> = [];
    const pages = [
      { tweets: [rawTweet('1')], has_next_page: true, next_cursor: 'c 1' },
      { tweets: [rawTweet('2')], has_next_page: true, next_cursor: 'c2' },
      { tweets: [rawTweet('3')], has_next_page: false, next_cursor: '' },
    ];
    let index = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      urls.push(String(input));
      headersSeen.push((init?.headers ?? {}) as Record<string, string>);
      const body = pages[index] ?? pages[pages.length - 1];
      index += 1;
      return jsonResponse(body);
    };

    const client = new TwitterApiClient({
      apiKey: 'mock_key',
      baseUrl: 'https://api.example.com/',
      fetchImpl,
      sleep: async () => {},
    });

    const tweets = await client.searchPool('a b#c', { maxPages: 5 });
    expect(tweets.map((tweet) => tweet.id)).toEqual(['1', '2', '3']);
    expect(urls).toEqual([
      'https://api.example.com/twitter/tweet/advanced_search?query=a%20b%23c&queryType=Latest',
      'https://api.example.com/twitter/tweet/advanced_search?query=a%20b%23c&queryType=Latest&cursor=c%201',
      'https://api.example.com/twitter/tweet/advanced_search?query=a%20b%23c&queryType=Latest&cursor=c2',
    ]);
    expect(headersSeen[0]).toMatchObject({
      'X-API-Key': 'mock_key',
      Accept: 'application/json',
    });

    index = 0;
    const capped = await client.searchPool('a b#c', { maxPages: 2 });
    expect(capped.map((tweet) => tweet.id)).toEqual(['1', '2']);

    const endless: typeof fetch = async () =>
      jsonResponse({
        tweets: [rawTweet(String(urls.length))],
        has_next_page: true,
        next_cursor: 'again',
      });
    const endlessClient = new TwitterApiClient({
      apiKey: 'k',
      baseUrl: 'https://api.example.com',
      fetchImpl: endless,
      sleep: async () => {},
    });
    const five = await endlessClient.searchPool('q');
    expect(five).toHaveLength(5);

    const bareUrls: string[] = [];
    const bareClient = new TwitterApiClient({
      apiKey: 'k',
      baseUrl: 'https://api.example.com',
      fetchImpl: async (input) => {
        bareUrls.push(String(input));
        return jsonResponse({ tweets: [], has_next_page: true, next_cursor: null });
      },
      sleep: async () => {},
    });
    const emptyCursor = await bareClient.searchRecent('hello', '');
    await bareClient.searchRecent('hello');
    expect(emptyCursor.hasNextPage).toBe(false);
    expect(emptyCursor.nextCursor).toBeNull();
    expect(bareUrls.every((url) => !url.includes('cursor='))).toBe(true);
  });
});
