import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GrokAnalysisResult } from '../../src/services/grok-runner.js';
import {
  chunkTelegramText,
  escapeTelegramHtml,
  formatDigestMessages,
  TelegramNotifier,
  type DigestContext,
} from '../../src/services/telegram-notifier.js';

function loadSample(): GrokAnalysisResult {
  const raw = readFileSync(new URL('../fixtures/grok_output_sample.json', import.meta.url), 'utf8');
  return JSON.parse(raw) as GrokAnalysisResult;
}

const context: DigestContext = {
  optimalPostingWindowsUTC: ['17:30', '11:30'],
  generatedAt: '2026-10-16T00:00:00.000Z',
};

describe('escapeTelegramHtml', () => {
  it('escapes ampersands before angle brackets', () => {
    expect(escapeTelegramHtml('<script> & C++ templates List<T>')).toBe(
      '&lt;script&gt; &amp; C++ templates List&lt;T&gt;',
    );
  });
});

describe('formatDigestMessages', () => {
  it('escapes draft HTML and attaches intent keyboards', () => {
    const analysis = loadSample();
    const draft = analysis.postDrafts[0];
    if (!draft) throw new Error('fixture missing post draft');
    draft.body = '<script> & C++ templates List<T>';

    const messages = formatDigestMessages(analysis, context);
    const escaped = '&lt;script&gt; &amp; C++ templates List&lt;T&gt;';
    const draftMessage = messages.find((message) => message.text.includes(escaped));
    expect(draftMessage).toBeDefined();
    expect(draftMessage?.text).toContain('<b>');
    expect(draftMessage?.text).toContain('<pre>');
    expect(draftMessage?.text).toContain('Media: 1:1 GIF or short silent screen capture');
    expect(draftMessage?.text).not.toContain('<script>');
    expect(
      draftMessage?.replyMarkup?.inline_keyboard[0]?.[0]?.url.startsWith('https://x.com/intent/tweet'),
    ).toBe(true);

    const replyMessage = messages.find((message) => message.text.includes('<b>Tactical replies</b>'));
    const rows = replyMessage?.replyMarkup?.inline_keyboard ?? [];
    expect(rows).toHaveLength(5);
    const rowUrls = rows[0]?.map((button) => button.url) ?? [];
    expect(rowUrls).toContain('https://x.com/pixelwitch/status/9001001');
    const intentUrl = rowUrls.find((url) => url.includes('/intent/tweet'));
    expect(intentUrl).toBeDefined();
    expect(new URL(intentUrl ?? '').searchParams.get('in_reply_to')).toBe('9001001');
  });
});

describe('chunkTelegramText', () => {
  it('hard-splits a long string without newlines', () => {
    const text = 'a'.repeat(5000);
    const chunks = chunkTelegramText(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length > 0 && chunk.length <= 4096)).toBe(true);
    expect(chunks.join('')).toBe(text);
  });

  it('splits 100 lines without dropping characters', () => {
    const text = Array.from({ length: 100 }, () => 'b'.repeat(50)).join('\n');
    const chunks = chunkTelegramText(text);
    expect(chunks.every((chunk) => chunk.length > 0 && chunk.length <= 4096)).toBe(true);
    expect(chunks.join('')).toBe(text);
  });
});

describe('TelegramNotifier.sendDigest', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('posts each formatted message and sleeps between calls', async () => {
    const analysis = loadSample();
    const expected = formatDigestMessages(analysis, context);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    let sleeps = 0;
    const notifier = new TelegramNotifier({
      token: 'TEST',
      chatId: '42',
      sleep: async () => {
        sleeps += 1;
      },
    });

    const result = await notifier.sendDigest(analysis, context);

    expect(result).toEqual({ skipped: false, sent: expected.length });
    expect(fetchMock).toHaveBeenCalledTimes(expected.length);
    expect(sleeps).toBe(fetchMock.mock.calls.length - 1);

    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).toBe('https://api.telegram.org/botTEST/sendMessage');
      const init = call[1];
      expect(init?.method).toBe('POST');
      const payload = JSON.parse(String(init?.body)) as {
        chat_id: string;
        parse_mode: string;
        disable_web_page_preview: boolean;
        reply_markup?: { inline_keyboard: Array<Array<{ url?: string }>> };
      };
      expect(payload.parse_mode).toBe('HTML');
      expect(payload.disable_web_page_preview).toBe(true);
      expect(payload.chat_id).toBe('42');
    }

    const payloads = fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)) as {
      reply_markup?: { inline_keyboard: Array<Array<{ url?: string }>> };
    });
    expect(payloads.some((payload) =>
      payload.reply_markup?.inline_keyboard.some((row) =>
        row.some((button) => typeof button.url === 'string' && button.url.length > 0),
      ),
    )).toBe(true);
  });

  it('skips when the token is omitted', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const notifier = new TelegramNotifier({ chatId: '42' });
    const result = await notifier.sendDigest(loadSample(), context);
    expect(result).toEqual({ skipped: true, sent: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
