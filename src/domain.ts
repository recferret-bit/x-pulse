export type PoolName = 'indiedev' | 'solana' | 'intersection';

export type InfluencerTier = 'rising_star' | 'whale';

export interface NormalizedTweet {
  id: string;
  pool: PoolName;
  authorId: string;
  authorUsername: string;
  authorFollowers: number;
  text: string;
  createdAt: string;
  likes: number;
  retweets: number;
  replies: number;
  quotes: number;
  views: number;
  hasMedia: boolean;
  hashtags: string[];
  url: string;
  viralityScore: number;
  ingestedAt: string;
}

export interface Influencer {
  authorId: string;
  username: string;
  followers: number;
  tier: InfluencerTier;
  avgViralityScore: number;
  outlierHits: number;
  lastSeenAt: string;
}

export interface FetchState {
  pool: PoolName;
  lastTweetId: string | null;
  lastFetchedAt: string;
}

export interface TermWeight {
  term: string;
  weight: number;
}

export interface GrokPayload {
  generatedAt: string;
  optimalPostingWindowsUTC: string[];
  termStats: {
    hashtags: TermWeight[];
    ngrams: TermWeight[];
  };
  outlierTweets: NormalizedTweet[];
  influencers: Influencer[];
}

export const OUTLIER_FRACTION = 0.15;
export const TIMING_FRACTION = 0.2;
export const PAYLOAD_TWEET_LIMIT = 35;
export const PAYLOAD_INFLUENCER_LIMIT = 15;
export const REPLY_TARGET_LIMIT = 5;
