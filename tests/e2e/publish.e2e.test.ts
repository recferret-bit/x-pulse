import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db/client.js';
import { TweetRepository } from '../../src/db/repository.js';
import {
  startMockTelegramServer,
  type MockTelegramServer,
  type RecordedTelegramButton,
  type RecordedTelegramMessage,
} from '../../src/harness/mock-telegram-server.js';
import { loadTwitterFixture, startMockTwitterServer, type MockTwitterServer } from '../../src/harness/mock-twitter-server.js';
import { GrokAnalysisSchema } from '../../src/services/grok-runner.js';
import { explainSelection, renderReadyToPostReport } from '../../src/services/selection-reasons.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const fixturePath = fileURLToPath(new URL('../fixtures/twitter_search_sample.json', import.meta.url));
const mockGrokPath = fileURLToPath(new URL('../../src/harness/mock-grok-cli.sh', import.meta.url));
const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx');
const readyToPostPath = path.join(repoRoot, 'workspace', 'reports', 'e2e-ready-to-post.md');

const DRAFT_HOOKS = [
  'Your wishlist spike is a lighting problem.',
  'Stop putting the game wallet on the hot path.',
  'Co-op inventories break on partial fills.',
];

const REPLY_IDS = ['9001001', '9001002', '9001003', '9001004', '9001005'];

interface ReadyPost {
  label: string;
  text: string;
  url: string;
}

describe('e2e publish', () => {
  let twitter: MockTwitterServer;
  let telegram: MockTelegramServer;

  beforeAll(async () => {
    twitter = await startMockTwitterServer(loadTwitterFixture(fixturePath));
    telegram = await startMockTelegramServer();
  });

  afterAll(async () => {
    await twitter.close();
    await telegram.close();
  });

  it('ingests mocked tweets, delivers a mocked Telegram digest, and writes X composer links', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'x-radar-e2e-'));
    const dbPath = path.join(root, 'xradar.db');
    const workspaceDir = path.join(root, 'workspace');
    await mkdir(workspaceDir, { recursive: true });
    const env = cliEnv({ dbPath, workspaceDir, twitterUrl: twitter.url, telegramUrl: telegram.url });

    try {
      telegram.reset();
      const ingest = await runCli('ingest', env);
      expect(ingest.code, ingest.stderr).toBe(0);
      expect(telegram.messages).toHaveLength(0);

      const dbAfterIngest = openDatabase(dbPath);
      const repository = new TweetRepository(dbAfterIngest);
      expect(repository.countTweets()).toBe(17);
      expect(repository.getTweet('9001991')).toBeNull();
      expect(repository.getTweet('9001992')).toBeNull();
      expect(repository.getTweet('9001993')).toBeNull();
      expect(repository.getInfluencer('501')).toMatchObject({ username: 'pixelwitch', tier: 'rising_star' });
      expect(repository.getInfluencer('502')).toMatchObject({ username: 'chainwhale', tier: 'whale' });
      expect(repository.getInfluencer('503')).toMatchObject({ username: 'shaderfox', tier: 'rising_star' });
      expect(repository.getFetchState('indiedev')?.lastTweetId).toMatch(/^\d+$/);
      expect(repository.getFetchState('solana')?.lastTweetId).toMatch(/^\d+$/);
      expect(repository.getFetchState('intersection')?.lastTweetId).toMatch(/^\d+$/);
      dbAfterIngest.close();

      const analyze = await runCli('analyze', env);
      expect(analyze.code, analyze.stderr).toBe(0);
      const analysis = GrokAnalysisSchema.parse(
        JSON.parse(await readFile(path.join(workspaceDir, 'output_latest.json'), 'utf8')),
      );
      expect(analysis.postDrafts).toHaveLength(3);
      expect(analysis.replyTargets.map((target) => target.tweetId)).toEqual(REPLY_IDS);

      const firstDigest = [...telegram.messages];
      const posts = assertPublishableDigest(firstDigest);
      const explainedDb = openDatabase(dbPath);
      const explainedRepo = new TweetRepository(explainedDb);
      const explanation = explainSelection({
        tweets: explainedRepo.listTweets(),
        influencers: explainedRepo.listInfluencers(15),
        analysis,
      });
      explainedDb.close();
      const postsWithReasons = posts.map((post, index) => ({
        ...post,
        reason: index < explanation.drafts.length
          ? explanation.drafts[index]?.reason
          : explanation.replies[index - explanation.drafts.length]?.reason,
      }));
      const markdown = renderReadyToPostReport(postsWithReasons, explanation);
      await mkdir(path.dirname(readyToPostPath), { recursive: true });
      await writeFile(readyToPostPath, markdown, 'utf8');
      expect(markdown).toContain('top 15%');
      expect(markdown).toContain('@pixelwitch');
      expect(markdown).toContain('under the top 15% cutoff');
      expect(firstDigest.find((message) => message.text.includes('Why these were selected'))?.text).toContain(
        'top 15%',
      );
      process.stdout.write(`\nReady to post: ${readyToPostPath}\n`);

      telegram.reset();
      const notify = await runCli('notify', env);
      expect(notify.code, notify.stderr).toBe(0);
      const resent = assertPublishableDigest(telegram.messages);
      expect(resent.map((post) => post.url)).toEqual(posts.map((post) => post.url));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('run-once produces the same three drafts and five replies through mocked Telegram', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'x-radar-e2e-once-'));
    const dbPath = path.join(root, 'xradar.db');
    const workspaceDir = path.join(root, 'workspace');
    await mkdir(workspaceDir, { recursive: true });
    telegram.reset();

    try {
      const run = await runCli(
        'run-once',
        cliEnv({ dbPath, workspaceDir, twitterUrl: twitter.url, telegramUrl: telegram.url }),
      );
      expect(run.code, run.stderr).toBe(0);
      const posts = assertPublishableDigest(telegram.messages);
      const drafts = posts.filter((post) => post.label.includes('Open Draft'));
      const replies = posts.filter((post) => post.label.includes('1-Click Reply'));
      expect(drafts.map((post) => post.text.split('\n\n')[0])).toEqual(DRAFT_HOOKS);
      expect(replies).toHaveLength(5);

      const db = openDatabase(dbPath);
      expect(new TweetRepository(db).countTweets()).toBe(17);
      db.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});

function cliEnv(options: {
  dbPath: string;
  workspaceDir: string;
  twitterUrl: string;
  telegramUrl: string;
}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    TWITTER_API_KEY: 'mock_key',
    TWITTER_API_BASE_URL: options.twitterUrl,
    DB_PATH: options.dbPath,
    GROK_WORKSPACE_DIR: options.workspaceDir,
    GROK_BIN_PATH: mockGrokPath,
    TELEGRAM_BOT_TOKEN: 'e2e-token',
    TELEGRAM_CHAT_ID: '4242',
    TELEGRAM_API_BASE_URL: options.telegramUrl,
    LOG_LEVEL: 'silent',
  };
}

function runCli(command: string, env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(tsxBin, ['src/index.ts', command], {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function assertPublishableDigest(messages: RecordedTelegramMessage[]): ReadyPost[] {
  expect(messages.length).toBeGreaterThanOrEqual(5);
  for (const message of messages) {
    expect(message.token).toBe('e2e-token');
    expect(message.chatId).toBe('4242');
    expect(message.parseMode).toBe('HTML');
    expect(message.disableWebPagePreview).toBe(true);
    expect(message.text.length).toBeLessThanOrEqual(4096);
  }

  const summary = messages.find((message) => message.text.includes('X-Radar Digest'));
  expect(summary?.text).toContain('09:30');
  expect(summary?.text).toContain('indiedev');
  expect(summary?.text).toContain('solana');
  expect(summary?.text).toContain('intersection');
  expect(summary?.text).toContain('Why these were selected');
  expect(summary?.text).toContain('top 15%');

  const draftButtons = buttonsNamed(messages, 'Open Draft');
  expect(draftButtons).toHaveLength(3);
  const drafts = draftButtons.map((button, index) => {
    const text = decodeIntent(button.url, 'text');
    expect([...text].length).toBeLessThanOrEqual(280);
    expect(text.startsWith(DRAFT_HOOKS[index] ?? '')).toBe(true);
    expect(text).toContain('#');
    expect(button.url.startsWith('https://x.com/intent/tweet?')).toBe(true);
    expect(button.url.includes('#')).toBe(false);
    return { label: button.text, text, url: button.url };
  });

  const replyButtons = buttonsNamed(messages, '1-Click Reply');
  expect(replyButtons.map((button) => new URL(button.url).searchParams.get('in_reply_to'))).toEqual(REPLY_IDS);
  const replies = replyButtons.map((button) => {
    const url = new URL(button.url);
    const text = url.searchParams.get('text') ?? '';
    expect(text.length).toBeGreaterThan(0);
    expect([...text].length).toBeLessThanOrEqual(280);
    expect(url.origin + url.pathname).toBe('https://x.com/intent/tweet');
    return { label: button.text, text, url: button.url };
  });

  const viewButtons = buttonsNamed(messages, 'View @');
  expect(viewButtons.map((button) => button.url)).toEqual([
    'https://x.com/pixelwitch/status/9001001',
    'https://x.com/chainwhale/status/9001002',
    'https://x.com/shaderfox/status/9001003',
    'https://x.com/netcoder/status/9001004',
    'https://x.com/validatornina/status/9001005',
  ]);

  const draftMessage = messages.find((message) => message.text.includes('Draft #1'));
  expect(draftMessage?.text).toContain('<pre>');
  expect(draftMessage?.text).toContain('Media:');

  return [...drafts, ...replies];
}

function buttonsNamed(messages: RecordedTelegramMessage[], labelPart: string): RecordedTelegramButton[] {
  return messages.flatMap((message) =>
    message.inlineKeyboard.flat().filter((button) => button.text.includes(labelPart)),
  );
}

function decodeIntent(rawUrl: string, key: 'text' | 'in_reply_to'): string {
  const value = new URL(rawUrl).searchParams.get(key);
  expect(value).toBeTruthy();
  return value ?? '';
}


