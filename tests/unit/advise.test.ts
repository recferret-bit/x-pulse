import { describe, expect, it } from 'vitest';
import { parseProjectSoul } from '../../src/services/soul.js';
import type { NormalizedTweet } from '../../src/domain.js';
import { adviseLookbackSlices, buildTopicQuery, composeAdvice, contentKindOf, readAdviseBrief, renderAdviceMarkdown } from '../../src/services/advise.js';

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
    expect(advice.hashtags).toEqual(['wishlist', 'falloff', 'torch']);
    expect(advice.bestTimeToPostUTC).toBe('09:30');
    expect(advice.options.find((option) => option.recommended)?.body).not.toContain('mechanic');
    expect(advice.mentions).toEqual([]);
    expect(advice.options.find((option) => option.recommended)?.body.startsWith('Attach')).toBe(false);
    expect(advice.why).toContain('GIF');
    expect(advice.contentKind).toBe('gif');
    expect(advice.options.filter((option) => option.kind === 'text').length).toBeGreaterThanOrEqual(2);
    expect(advice.options.find((option) => option.recommended)?.label).toBe('GIF');
    expect(advice.options.find((option) => option.kind === 'gif')?.reason).toContain('pixelwitch');
  });

  it('searches the distinctive words and ignores unrelated high-score posts', () => {
    const query = buildTopicQuery('I shiped multi-agent general project+code and solana audit library');
    expect(query.startsWith('solana (')).toBe(true);
    expect(query).toContain('audit');
    expect(query).toContain('"multi-agent"');
    expect(query).not.toContain('shiped');
    expect(query).not.toContain('project');
    expect(query).not.toContain(' code');

    const advice = composeAdvice({
      topic: 'I shiped multi-agent general project+code and solana audit library',
      query,
      searched: 40,
      tweets: [
        sample(
          '1',
          'ZhangRuonanPH',
          274,
          10,
          28,
          ['springbanquet', 'zhangruonan'],
          true,
          'Fanclub support project for the spring banquet.',
        ),
        sample(
          '2',
          'auditnix',
          4000,
          20,
          4,
          ['solana', 'audit'],
          false,
          'Open sourced a Solana audit library for multi-agent reviews.',
        ),
        sample('3', 'pricebot', 90000, 500, 40, ['solana'], false, 'Solana price is up today.'),
      ],
    });

    expect(advice.evidence.map((item) => item.authorUsername)).toEqual(['auditnix']);
    expect(advice.hashtags).toEqual(['audit', 'solana']);
    expect(advice.reading).toMatch(/launch post/i);
    expect(advice.reading.toLowerCase()).toContain('solana audit library');
    expect(advice.reading.toLowerCase()).toContain('multi-agent');
    expect(advice.title.toLowerCase()).toContain('solana');
    expect(advice.evidence.map((item) => item.authorUsername)).not.toContain('pricebot');
    expect(renderAdviceMarkdown(advice).toLowerCase()).toContain('solana audit library');
    expect(advice.options.every((option) => !option.body.includes('mechanic') && !option.body.includes('trailer') && !option.body.includes('Attach'))).toBe(true);
    expect(advice.options.find((option) => option.kind === 'text' && option.label.includes('result'))?.body).toContain('checks Solana programs');
    expect(advice.title).toBe('Open-sourced a multi-agent codebase and a Solana audit library');
    expect(advice.why.split('\n\n').length).toBeGreaterThan(3);

    const voiced = composeAdvice({
      topic: 'I shiped multi-agent general project+code and solana audit library',
      query,
      searched: 40,
      tweets: advice.evidence.length > 0 ? [] : [],
      soul: parseProjectSoul([
        'What: A multi-agent codebase and a Solana audit library.',
        'Mood: Precise and dry.',
        'Style: Short sentences.',
        'Title: Open-sourced a Solana audit library and the multi-agent codebase that runs it',
        'Launch: The audit library checks Solana programs before they land.',
        'Constraint: Start with the audit library.',
      ].join('\n')),
    });
    expect(voiced.title).toContain('Solana audit library');
    expect(voiced.options.find((option) => option.label.includes('result'))?.body).toContain('checks Solana programs before they land');
    expect(voiced.why).toContain('Voice: Precise and dry.');

    const truck = parseProjectSoul([
      'What: A truck simulator on Solana. Paid prizes, long rides, NFTs, and tools built for streamers.',
      'Audience: Solana community, web2 truck sim players, young players who want web3 prizes',
      'Seek: "truck simulator", "solana gaming", "prize pool"',
      'Mood: Meme, loud, hyped.',
      'Title: Long ride. Real prize. Your stream is not ready.',
      'Launch: Paid prizes. A long haul. You in, or you watching?',
      'Constraint: Think you can hold the lane?',
    ].join('\n'));
    const truckAdvice = composeAdvice({
      topic: 'posting the truck simulator on solana with paid prizes for streamers',
      query: 'solana (truck OR simulator)',
      searched: 3,
      tweets: [],
      soul: truck,
    });
    expect(truckAdvice.title).toBe('Long ride. Real prize. Your stream is not ready.');
    expect(truckAdvice.options.find((option) => option.label.includes('result'))?.body).toContain('You in, or you watching?');
    expect(truckAdvice.why).toContain('Meme, loud, hyped.');
    const aimed = buildTopicQuery('weekly prize for a long shift', truck);
    expect(aimed).toContain('"truck simulator"');
    expect(aimed).toContain('"solana gaming"');
    const markdown = renderAdviceMarkdown(advice);
    expect(markdown).toContain('- Label:');
    expect(markdown).toContain('- Hashtags: #audit #solana');
    expect(markdown).toContain('- Text:');
    expect(markdown).toContain('Open sourced a Solana audit library');
  });

  it('samples the last 7 days in three one-page slices', () => {
    const now = new Date('2026-04-15T12:00:00.000Z');
    const slices = adviseLookbackSlices(now);
    expect(slices).toHaveLength(3);
    expect(slices[0]?.until).toBe(Math.floor(now.getTime() / 1000));
    expect(slices[2]?.since).toBe(slices[0]!.until - 7 * 24 * 60 * 60);
    expect(slices[0]?.since).toBe(slices[1]?.until);
    expect(slices[1]?.since).toBe(slices[2]?.until);
    const query = buildTopicQuery('solana audit library');
    expect(query).not.toContain('since_time:');
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
