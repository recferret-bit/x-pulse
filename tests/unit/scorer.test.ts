import { describe, expect, it } from 'vitest';
import {
  aggregateTerms,
  buildTimingProfile,
  calculateViralityScore,
  classifyInfluencerTier,
  optimalPostingWindowsUTC,
  selectTopFraction,
  type ViralityInput,
} from '../../src/services/scorer.js';

const NOW = new Date('2026-04-15T12:00:00.000Z');

function tweet(overrides: Partial<ViralityInput> = {}): ViralityInput {
  return {
    likes: 0,
    retweets: 0,
    replies: 0,
    quotes: 0,
    authorFollowers: 100,
    createdAt: NOW,
    ...overrides,
  };
}

describe('calculateViralityScore', () => {
  it('scores a small account higher than a large account with more likes', () => {
    const small = calculateViralityScore(
      tweet({ likes: 100, authorFollowers: 500, createdAt: NOW }),
      NOW,
    );
    const large = calculateViralityScore(
      tweet({ likes: 500, authorFollowers: 500_000, createdAt: NOW }),
      NOW,
    );
    expect(small).toBeGreaterThan(large);
  });

  it('decays as the tweet ages', () => {
    const engagement = { likes: 40, retweets: 2, replies: 1, quotes: 1, authorFollowers: 1_000 };
    const score2h = calculateViralityScore(
      tweet({ ...engagement, createdAt: '2026-04-15T10:00:00.000Z' }),
      NOW,
    );
    const score12h = calculateViralityScore(
      tweet({ ...engagement, createdAt: '2026-04-15T00:00:00.000Z' }),
      NOW,
    );
    const score48h = calculateViralityScore(
      tweet({ ...engagement, createdAt: '2026-04-13T12:00:00.000Z' }),
      NOW,
    );
    expect(score2h).toBeGreaterThan(score12h);
    expect(score12h).toBeGreaterThan(score48h);
  });

  it('matches the known value when the tweet is posted now', () => {
    const score = calculateViralityScore(
      tweet({ likes: 100, authorFollowers: 100, createdAt: NOW }),
      NOW,
    );
    expect(score).toBeCloseTo(1000 / Math.pow(2, 1.5), 5);
  });

  it('rejects an invalid createdAt', () => {
    expect(() => calculateViralityScore(tweet({ createdAt: 'not-a-date' }), NOW)).toThrow(
      new Error('Invalid tweet createdAt'),
    );
  });
});

describe('classifyInfluencerTier', () => {
  it('applies the rising_star and whale boundaries', () => {
    expect(classifyInfluencerTier(999)).toBeNull();
    expect(classifyInfluencerTier(1000)).toBe('rising_star');
    expect(classifyInfluencerTier(25_000)).toBe('rising_star');
    expect(classifyInfluencerTier(25_001)).toBe('whale');
  });
});

describe('optimal posting windows', () => {
  it('returns the top three peak hours shifted back 30 minutes', () => {
    const tweets = [
      { viralityScore: 100, createdAt: '2026-04-15T18:10:00.000Z' },
      { viralityScore: 90, createdAt: '2026-04-15T12:10:00.000Z' },
      { viralityScore: 80, createdAt: '2026-04-15T06:10:00.000Z' },
      ...Array.from({ length: 12 }, () => ({
        viralityScore: 1,
        createdAt: '2026-04-15T00:10:00.000Z',
      })),
    ];
    expect(optimalPostingWindowsUTC(tweets)).toEqual(['17:30', '11:30', '05:30']);

    const profile = buildTimingProfile(tweets);
    expect(profile.hourWeights).toHaveLength(24);
    expect(profile.dayHourWeights).toHaveLength(7);
    expect(profile.dayHourWeights.every((row) => row.length === 24)).toBe(true);
    expect(profile.hourWeights[18]).toBe(100);
    expect(profile.hourWeights[12]).toBe(90);
    expect(profile.hourWeights[6]).toBe(80);
    expect(profile.hourWeights[0]).toBe(0);
  });

  it('labels midnight as 23:30 and returns fewer than three windows when needed', () => {
    expect(
      optimalPostingWindowsUTC([{ viralityScore: 10, createdAt: '2026-04-15T00:20:00.000Z' }]),
    ).toEqual(['23:30']);
  });

  it('ignores tweets with an invalid createdAt', () => {
    expect(
      optimalPostingWindowsUTC(
        [
          { viralityScore: 50, createdAt: 'nope' },
          { viralityScore: 10, createdAt: '2026-04-15T06:00:00.000Z' },
        ],
        1,
      ),
    ).toEqual(['05:30']);
  });
});

describe('selectTopFraction', () => {
  it('keeps every item tied on the cutoff', () => {
    const items = [
      { id: 'a', score: 10 },
      { id: 'b', score: 5 },
      { id: 'c', score: 5 },
      { id: 'd', score: 1 },
    ];
    const selected = selectTopFraction(items, (item) => item.score, 0.5);
    expect(selected.map((item) => item.id)).toEqual(['a', 'b', 'c']);
  });

  it('returns an empty array for empty input', () => {
    expect(selectTopFraction([], () => 1, 0.2)).toEqual([]);
  });
});

describe('aggregateTerms', () => {
  it('sums a repeated hashtag once per selected tweet', () => {
    const result = aggregateTerms(
      [
        { text: '', hashtags: ['#IndieDev'], viralityScore: 10 },
        { text: '', hashtags: ['#IndieDev'], viralityScore: 5 },
      ],
      1,
    );
    expect(result.hashtags).toEqual([{ term: 'indiedev', weight: 15 }]);
  });

  it('builds distinct stopword-filtered bigrams and sorts ties by term', () => {
    const result = aggregateTerms(
      [
        {
          text: 'Build the viral game. Viral game 2026!',
          hashtags: ['#IndieDev', 'IndieDev'],
          viralityScore: 10,
        },
      ],
      1,
    );
    expect(result.hashtags).toEqual([{ term: 'indiedev', weight: 10 }]);
    expect(result.ngrams).toEqual([
      { term: 'build viral', weight: 10 },
      { term: 'game viral', weight: 10 },
      { term: 'viral game', weight: 10 },
    ]);
  });
});
