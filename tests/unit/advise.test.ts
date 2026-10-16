import { describe, expect, it } from 'vitest';
import type { NormalizedTweet } from '../../src/domain.js';
import { buildTopicQuery, composeAdvice, contentKindOf, readAdviseBrief } from '../../src/services/advise.js';

describe('advise', () => {
  it('reads the brief from the words after the command', () => {
    expect(readAdviseBrief(['node', 'src/index.ts', 'advise', '--', 'torch', 'falloff'])).toBe('torch falloff');
    expect(readAdviseBrief(['node', 'src/index.ts', 'advise'])).toBe('');
  });

  it('builds an X search from concrete words in the brief', () => {
    const query = buildTopicQuery('I want to post about a torch falloff wishlist on Steam');
    expect(query).toContain('torch');
    expect(query).toContain('falloff');
    expect(query).toContain('wishlist');
    expect(query).toContain('min_faves:10');
    expect(query).toContain('-is:retweet');
    expect(query).not.toContain('want');
    expect(query).not.toContain('about');
    expect(() => buildTopicQuery('I want to post')).toThrow(/concrete words/);
  });

  it('proposes hashtags, a time, and evidence from the strongest similar posts', () => {
    const advice = composeAdvice({
      topic: 'torch falloff wishlist',
      query: '(torch OR falloff OR wishlist) min_faves:10 -is:retweet lang:en',
      searched: 4,
      tweets: [
        sample('9001001', 'pixelwitch', 2000, 200, 12, ['indiedev', 'gamedev'], true, 'Shipped the torch falloff GIF. Wishlist on Steam jumped.'),
        sample('9001004', 'netcoder', 20000, 10, 0.2, ['gamedev'], false, 'Lockstep notes from a prototype.'),
      ],
    });

    expect(advice.evidence[0]?.authorUsername).toBe('pixelwitch');
    expect(advice.evidence[0]?.reason).toContain('200 likes');
    expect(advice.evidence[0]?.reason).toContain('2000 followers');
    expect(advice.evidence[0]?.reason).toContain('torch');
    expect(advice.hashtags).toContain('indiedev');
    expect(advice.bestTimeToPostUTC).toBe('09:30');
    expect(advice.mentions).toEqual(['pixelwitch']);
    expect(advice.why).toContain('GIF');
    expect(advice.contentKind).toBe('gif');
    expect(advice.options.filter((option) => option.kind === 'text').length).toBeGreaterThanOrEqual(2);
    expect(advice.options.find((option) => option.recommended)?.label).toBe('GIF');
    expect(advice.options.find((option) => option.kind === 'gif')?.reason).toContain('pixelwitch');
  });

  it('prefers an attached video over the word gif in the text', () => {
    expect(contentKindOf('A 12-frame GIF of the mechanic', true, ['video'])).toBe('video');
    expect(contentKindOf('A 12-frame GIF of the mechanic', true, ['photo'])).toBe('image');
    expect(contentKindOf('Lockstep notes from a prototype', false, [])).toBe('text');
  });
});

function sample(
  id: string,
  username: string,
  followers: number,
  likes: number,
  score: number,
  hashtags: string[],
  hasMedia: boolean,
  text: string,
): NormalizedTweet {
  return {
    id,
    pool: 'indiedev',
    authorId: id,
    authorUsername: username,
    authorFollowers: followers,
    text,
    createdAt: '2026-04-15T10:00:00.000Z',
    likes,
    retweets: 0,
    replies: 0,
    quotes: 0,
    views: 100,
    hasMedia,
    hashtags,
    url: `https://x.com/${username}/status/${id}`,
    viralityScore: score,
    ingestedAt: '2026-04-15T12:00:00.000Z',
  };
}
