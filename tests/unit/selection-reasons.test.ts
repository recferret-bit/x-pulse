import { describe, expect, it } from 'vitest';
import type { Influencer, NormalizedTweet } from '../../src/domain.js';
import type { GrokAnalysisResult } from '../../src/services/grok-runner.js';
import { explainSelection } from '../../src/services/selection-reasons.js';

describe('explainSelection', () => {
  it('names the score cutoff, the follower tier, and playbook-only replies', () => {
    const tweets = [
      tweet('1', 'alpha', '11', 2000, 200, 10),
      tweet('2', 'bravo', '22', 50_000, 2000, 5),
      ...Array.from({ length: 8 }, (_, index) =>
        tweet(String(index + 3), `quiet${index}`, String(100 + index), 20_000, 10, 0.1),
      ),
    ];
    const influencers: Influencer[] = [
      influencer('11', 'alpha', 2000, 'rising_star', 10),
      influencer('22', 'bravo', 50_000, 'whale', 5),
    ];
    const analysis: GrokAnalysisResult = {
      trends: [
        {
          pool: 'indiedev',
          topic: 'Readable mechanics',
          whyItWorked: 'The mechanic was visible in one second.',
          mediaFormatRecommendation: 'GIF',
        },
      ],
      postDrafts: [
        {
          hook: 'Show the mechanic.',
          body: 'A short capture beat the trailer.',
          recommendedHashtags: ['indiedev'],
          accountsToMention: ['alpha'],
          bestTimeToPostUTC: '17:30',
        },
      ],
      replyTargets: [
        {
          tweetId: '1',
          tweetUrl: 'https://x.com/alpha/status/1',
          authorUsername: 'alpha',
          tier: 'rising_star',
          suggestedReply: 'Post the curve next to the capture.',
        },
        {
          tweetId: '3',
          tweetUrl: 'https://x.com/quiet0/status/3',
          authorUsername: 'quiet0',
          tier: 'rising_star',
          suggestedReply: 'This one did not clear the bar.',
        },
      ],
    };

    const explanation = explainSelection({ tweets, influencers, analysis });

    expect(explanation.kept.map((account) => account.username)).toEqual(['alpha', 'bravo']);
    expect(explanation.kept[0]?.reason).toContain('ranked 1 of 10');
    expect(explanation.kept[0]?.reason).toContain('1,000–25,000');
    expect(explanation.kept[0]?.reason).toContain('rising_star');
    expect(explanation.kept[1]?.reason).toContain('whale');
    expect(explanation.kept[1]?.reason).toContain('above 25,000');
    expect(explanation.windows.map((window) => window.label)).toEqual(['09:30']);
    expect(explanation.windows[0]?.reason).toContain('UTC hour 10');
    expect(explanation.windows[0]?.reason).toContain('30 minutes');
    expect(explanation.drafts[0]?.reason).toContain('The mechanic was visible in one second.');
    expect(explanation.drafts[0]?.reason).toContain('@alpha');
    expect(explanation.drafts[0]?.reason).toContain('17:30');
    expect(explanation.drafts[0]?.reason).toContain('09:30');
    expect(explanation.replies[0]?.reason).toContain('The scorer selected @alpha');
    expect(explanation.replies[1]?.reason).toContain('The scorer did not');
    expect(explanation.replies[1]?.reason).toContain('under the top 15% cutoff');
  });
});

function tweet(
  id: string,
  username: string,
  authorId: string,
  followers: number,
  likes: number,
  score: number,
): NormalizedTweet {
  return {
    id,
    pool: 'indiedev',
    authorId,
    authorUsername: username,
    authorFollowers: followers,
    text: `${username} shipped a mechanic`,
    createdAt: '2026-04-15T10:00:00.000Z',
    likes,
    retweets: 0,
    replies: 0,
    quotes: 0,
    views: 100,
    hasMedia: false,
    hashtags: ['indiedev'],
    url: `https://x.com/${username}/status/${id}`,
    viralityScore: score,
    ingestedAt: '2026-04-15T12:00:00.000Z',
  };
}

function influencer(
  authorId: string,
  username: string,
  followers: number,
  tier: Influencer['tier'],
  score: number,
): Influencer {
  return {
    authorId,
    username,
    followers,
    tier,
    avgViralityScore: score,
    outlierHits: 1,
    lastSeenAt: '2026-04-15T12:00:00.000Z',
  };
}
