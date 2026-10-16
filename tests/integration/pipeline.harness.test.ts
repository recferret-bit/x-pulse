import { chmod, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Env } from '../../src/config/env.js';
import { openDatabase } from '../../src/db/client.js';
import { TweetRepository } from '../../src/db/repository.js';
import { silentLogger } from '../../src/logger.js';
import { loadTwitterFixture, startMockTwitterServer } from '../../src/harness/mock-twitter-server.js';
import { DIGEST_CRON, INGEST_CRON, runOnce } from '../../src/pipeline.js';
import { GrokAnalysisSchema, GrokRunner } from '../../src/services/grok-runner.js';
import { TelegramNotifier } from '../../src/services/telegram-notifier.js';
import { TwitterApiClient } from '../../src/services/twitter-api.js';

const fixturePath = fileURLToPath(new URL('../fixtures/twitter_search_sample.json', import.meta.url));
const mockGrokPath = fileURLToPath(new URL('../../src/harness/mock-grok-cli.sh', import.meta.url));

describe('pipeline harness', () => {
  it('schedules ingest every 3 hours and the digest at 08:00 and 17:00 UTC', () => {
    expect(INGEST_CRON).toBe('0 */3 * * *');
    expect(DIGEST_CRON).toBe('0 8,17 * * *');
  });

  it('ingests the fixture, stores influencers, and validates grok output', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'x-radar-'));
    const dbPath = path.join(root, 'xradar.db');
    const workspaceDir = path.join(root, 'workspace');
    await mkdir(workspaceDir, { recursive: true });
    const now = new Date('2026-04-15T12:00:00.000Z');

    let server: Awaited<ReturnType<typeof startMockTwitterServer>> | undefined;
    let db: ReturnType<typeof openDatabase> | undefined;

    try {
      await ensureExecutable(mockGrokPath);
      const fixture = loadTwitterFixture(fixturePath);
      server = await startMockTwitterServer(fixture);
      db = openDatabase(dbPath);
      const env: Env = {
        TWITTER_API_KEY: 'mock_key',
        TWITTER_API_BASE_URL: server.url,
        DB_PATH: dbPath,
        GROK_WORKSPACE_DIR: workspaceDir,
        GROK_BIN_PATH: mockGrokPath,
        TELEGRAM_API_BASE_URL: 'https://api.telegram.org',
      };
      const repository = new TweetRepository(db);
      const deps = {
        env,
        db,
        repository,
        twitter: new TwitterApiClient({
          apiKey: 'mock_key',
          baseUrl: server.url,
          sleep: () => Promise.resolve(),
          logger: silentLogger,
        }),
        grok: new GrokRunner({
          binPath: mockGrokPath,
          workspaceDir,
          logger: silentLogger,
        }),
        telegram: new TelegramNotifier({ logger: silentLogger }),
        now,
        logger: silentLogger,
      };

      await runOnce(deps);

      expect(repository.getTweet('9001991')).toBeNull();
      expect(repository.getTweet('9001992')).toBeNull();
      expect(repository.getTweet('9001993')).toBeNull();
      expect(repository.countTweets()).toBe(17);

      expect(repository.getInfluencer('501')).toMatchObject({
        username: 'pixelwitch',
        tier: 'rising_star',
        followers: 2000,
      });
      expect(repository.getInfluencer('502')).toMatchObject({
        username: 'chainwhale',
        tier: 'whale',
        followers: 50000,
      });
      expect(repository.getInfluencer('503')).toMatchObject({
        username: 'shaderfox',
        tier: 'rising_star',
        followers: 10000,
      });
      expect(repository.listInfluencers(10)).toHaveLength(3);

      const showcase = repository.getTweet('9001001');
      const quieter = repository.getTweet('9001004');
      expect(showcase).not.toBeNull();
      expect(showcase?.pool).toBe('indiedev');
      expect(showcase!.viralityScore).toBeGreaterThan(quieter!.viralityScore);

      const output = JSON.parse(await readFile(path.join(workspaceDir, 'output_latest.json'), 'utf8')) as unknown;
      const analysis = GrokAnalysisSchema.parse(output);
      expect(analysis.replyTargets.every((target) => typeof target.tweetId === 'string')).toBe(true);
    } finally {
      db?.close();
      await server?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function ensureExecutable(filePath: string): Promise<void> {
  const info = await stat(filePath);
  if ((info.mode & 0o111) === 0) {
    await chmod(filePath, 0o755);
  }
}
