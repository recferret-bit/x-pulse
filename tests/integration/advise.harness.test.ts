import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { silentLogger } from '../../src/logger.js';
import { startMockTelegramServer, type MockTelegramServer } from '../../src/harness/mock-telegram-server.js';
import { loadTwitterFixture, startMockTwitterServer, type MockTwitterServer } from '../../src/harness/mock-twitter-server.js';
import { runAdvise } from '../../src/services/advise.js';
import { TelegramNotifier } from '../../src/services/telegram-notifier.js';
import { TwitterApiClient } from '../../src/services/twitter-api.js';

const fixturePath = fileURLToPath(new URL('../fixtures/twitter_search_sample.json', import.meta.url));

describe('advise harness', () => {
  let twitterServer: MockTwitterServer;
  let telegramServer: MockTelegramServer;

  beforeAll(async () => {
    twitterServer = await startMockTwitterServer(loadTwitterFixture(fixturePath));
    telegramServer = await startMockTelegramServer();
  });

  afterAll(async () => {
    await twitterServer.close();
    await telegramServer.close();
  });

  it('searches similar posts and sends the draft plus evidence to Telegram', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'x-pulse-advise-'));
    telegramServer.reset();
    try {
      const advice = await runAdvise({
        brief: 'I want to post about a torch falloff GIF that grew Steam wishlists',
        twitter: new TwitterApiClient({
          apiKey: 'mock_key',
          baseUrl: twitterServer.url,
          sleep: () => Promise.resolve(),
          logger: silentLogger,
        }),
        telegram: new TelegramNotifier({
          token: 'e2e-token',
          chatId: '4242',
          apiBaseUrl: telegramServer.url,
          sleep: () => Promise.resolve(),
          logger: silentLogger,
        }),
        now: new Date('2026-04-15T12:00:00.000Z'),
        logger: silentLogger,
        maxPages: 1,
        workspaceDir: root,
      });

      expect(advice.evidence[0]?.authorUsername).toBe('pixelwitch');
      expect(advice.evidence[0]?.url).toBe('https://x.com/pixelwitch/status/9001001');
      expect(advice.evidence.map((item) => item.tweetId)).not.toContain('9001991');
      expect(advice.evidence.map((item) => item.tweetId)).not.toContain('9001993');
      expect(advice.bestTimeToPostUTC).toBe('09:30');
      expect(advice.why).toContain('200 likes');
      expect(advice.contentKind).toBe('image');
      expect(advice.options.some((option) => option.kind === 'text' && option.body.length > 0)).toBe(true);
      expect(advice.options.find((option) => option.recommended)?.reason).toContain('%');

      const proposal = telegramServer.messages.find((message) => message.text.includes('One-shot post advice'));
      expect(proposal?.text).toContain('Why');
      expect(proposal?.text).toContain('torch falloff');
      expect(proposal?.text).toContain('09:30');
      expect(proposal?.text).toContain('Options');
      expect(proposal?.text).toContain('Text, result first');
      const draftUrl = proposal?.inlineKeyboard.flat().find((button) => button.text.includes('Open option'))?.url;
      expect(draftUrl?.startsWith('https://x.com/intent/tweet?')).toBe(true);
      const draftText = new URL(draftUrl ?? 'https://x.com').searchParams.get('text') ?? '';
      expect(draftText).toContain('@pixelwitch');
      expect([...draftText].length).toBeLessThanOrEqual(280);

      const evidence = telegramServer.messages.find((message) => message.text.includes('Evidence from similar posts'));
      expect(evidence?.text).toContain('https://x.com/pixelwitch/status/9001001');
      expect(evidence?.text).toContain('2000 followers');
      expect(evidence?.inlineKeyboard[0]?.[0]?.url).toBe('https://x.com/pixelwitch/status/9001001');

      const saved = await readFile(path.join(root, 'reports', 'advise_latest.md'), 'utf8');
      expect(saved).toContain('## Why');
      expect(saved).toContain('pixelwitch');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
