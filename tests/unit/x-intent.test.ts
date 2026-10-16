import { describe, expect, it } from 'vitest';
import { buildPostIntentUrl, buildReplyIntentUrl } from '../../src/services/x-intent.js';

describe('buildPostIntentUrl', () => {
  it('percent-encodes special characters in the tweet text', () => {
    const url = buildPostIntentUrl({
      hook: 'Hook #1?',
      body: 'A & B\nline 🔥',
      recommendedHashtags: ['indiedev'],
      accountsToMention: ['grok'],
      bestTimeToPostUTC: '17:30',
    });
    const parsed = new URL(url);

    expect(`${parsed.origin}${parsed.pathname}`).toBe('https://x.com/intent/tweet');
    const text = parsed.searchParams.get('text') ?? '';
    expect(text).toContain('#');
    expect(text).toContain('&');
    expect(text).toContain('?');
    expect(text).toContain('\n');
    expect(text).toContain('🔥');
    expect(text).toContain('@grok');
    expect(text).toContain('#indiedev');
    expect(url).toContain('%23');
    expect(url).toContain('%26');
    expect(url).toContain('%3F');
    expect(url).toContain('%0A');
    expect(url).toContain('%F0%9F%94%A5');
    expect(url.includes('#')).toBe(false);
  });

  it('limits the text parameter to 280 code points', () => {
    const url = buildPostIntentUrl({
      hook: 'Hook',
      body: 'x'.repeat(400),
      recommendedHashtags: [],
      accountsToMention: [],
      bestTimeToPostUTC: '17:30',
    });
    const text = new URL(url).searchParams.get('text') ?? '';
    expect([...text].length).toBeLessThanOrEqual(280);
  });
});

describe('buildReplyIntentUrl', () => {
  it('keeps a large tweet id as an exact decimal string', () => {
    const tweetId = '18014398509481984001';
    const url = buildReplyIntentUrl(tweetId, 'Nice architecture.');
    expect(new URL(url).searchParams.get('in_reply_to')).toBe(tweetId);
    expect(url).toContain(`in_reply_to=${tweetId}`);
  });
});
