import type Database from 'better-sqlite3';
import type {
  FetchState,
  Influencer,
  InfluencerTier,
  NormalizedTweet,
  PoolName,
} from '../domain.js';

interface TweetRow {
  id: string;
  pool: PoolName;
  author_id: string;
  author_username: string;
  author_followers: number;
  text: string;
  created_at: string;
  likes: number;
  retweets: number;
  replies: number;
  quotes: number;
  views: number;
  has_media: number;
  hashtags_json: string;
  url: string;
  virality_score: number;
  ingested_at: string;
}

interface InfluencerRow {
  author_id: string;
  username: string;
  followers: number;
  tier: InfluencerTier;
  avg_virality_score: number;
  outlier_hits: number;
  last_seen_at: string;
}

interface FetchStateRow {
  pool: PoolName;
  last_tweet_id: string | null;
  last_fetched_at: string;
}

interface OutlierInput {
  authorId: string;
  username: string;
  followers: number;
  tier: InfluencerTier;
  viralityScore: number;
  seenAt: string;
}

const TWEET_COLUMNS = `
  id,
  pool,
  author_id,
  author_username,
  author_followers,
  text,
  created_at,
  likes,
  retweets,
  replies,
  quotes,
  views,
  has_media,
  hashtags_json,
  url,
  virality_score,
  ingested_at
`;

const INFLUENCER_COLUMNS = `
  author_id,
  username,
  followers,
  tier,
  avg_virality_score,
  outlier_hits,
  last_seen_at
`;

function parseHashtags(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const hashtags: string[] = [];
    for (const item of parsed) {
      if (typeof item !== 'string') return [];
      hashtags.push(item);
    }
    return hashtags;
  } catch {
    return [];
  }
}

function mapTweet(row: TweetRow): NormalizedTweet {
  return {
    id: row.id,
    pool: row.pool,
    authorId: row.author_id,
    authorUsername: row.author_username,
    authorFollowers: row.author_followers,
    text: row.text,
    createdAt: row.created_at,
    likes: row.likes,
    retweets: row.retweets,
    replies: row.replies,
    quotes: row.quotes,
    views: row.views,
    hasMedia: row.has_media === 1,
    hashtags: parseHashtags(row.hashtags_json),
    url: row.url,
    viralityScore: row.virality_score,
    ingestedAt: row.ingested_at,
  };
}

function mapInfluencer(row: InfluencerRow): Influencer {
  return {
    authorId: row.author_id,
    username: row.username,
    followers: row.followers,
    tier: row.tier,
    avgViralityScore: row.avg_virality_score,
    outlierHits: row.outlier_hits,
    lastSeenAt: row.last_seen_at,
  };
}

function mapFetchState(row: FetchStateRow): FetchState {
  return {
    pool: row.pool,
    lastTweetId: row.last_tweet_id,
    lastFetchedAt: row.last_fetched_at,
  };
}

export class TweetRepository {
  private readonly upsertTweetStmt;
  private readonly getTweetStmt;
  private readonly listTweetsStmt;
  private readonly countTweetsStmt;
  private readonly getInfluencerStmt;
  private readonly upsertInfluencerStmt;
  private readonly listInfluencersStmt;
  private readonly getFetchStateStmt;
  private readonly setFetchStateStmt;
  private readonly recordOutlier;

  constructor(db: Database.Database) {
    this.upsertTweetStmt = db.prepare(`
      INSERT INTO tweets (
        id,
        pool,
        author_id,
        author_username,
        author_followers,
        text,
        created_at,
        likes,
        retweets,
        replies,
        quotes,
        views,
        has_media,
        hashtags_json,
        url,
        virality_score,
        ingested_at
      ) VALUES (
        @id,
        @pool,
        @authorId,
        @authorUsername,
        @authorFollowers,
        @text,
        @createdAt,
        @likes,
        @retweets,
        @replies,
        @quotes,
        @views,
        @hasMedia,
        @hashtagsJson,
        @url,
        @viralityScore,
        @ingestedAt
      )
      ON CONFLICT(id) DO UPDATE SET
        pool = excluded.pool,
        author_id = excluded.author_id,
        author_username = excluded.author_username,
        author_followers = excluded.author_followers,
        text = excluded.text,
        created_at = excluded.created_at,
        likes = excluded.likes,
        retweets = excluded.retweets,
        replies = excluded.replies,
        quotes = excluded.quotes,
        views = excluded.views,
        has_media = excluded.has_media,
        hashtags_json = excluded.hashtags_json,
        url = excluded.url,
        virality_score = excluded.virality_score,
        ingested_at = tweets.ingested_at
    `);

    this.getTweetStmt = db.prepare(`
      SELECT ${TWEET_COLUMNS}
      FROM tweets
      WHERE id = ?
    `);

    this.listTweetsStmt = db.prepare(`
      SELECT ${TWEET_COLUMNS}
      FROM tweets
      ORDER BY virality_score DESC, id ASC
    `);

    this.countTweetsStmt = db.prepare('SELECT COUNT(*) AS count FROM tweets').pluck();

    this.getInfluencerStmt = db.prepare(`
      SELECT ${INFLUENCER_COLUMNS}
      FROM influencers
      WHERE author_id = ?
    `);

    this.upsertInfluencerStmt = db.prepare(`
      INSERT INTO influencers (
        author_id,
        username,
        followers,
        tier,
        avg_virality_score,
        outlier_hits,
        last_seen_at
      ) VALUES (
        @authorId,
        @username,
        @followers,
        @tier,
        @avgViralityScore,
        @outlierHits,
        @lastSeenAt
      )
      ON CONFLICT(author_id) DO UPDATE SET
        username = excluded.username,
        followers = excluded.followers,
        tier = excluded.tier,
        avg_virality_score = excluded.avg_virality_score,
        outlier_hits = excluded.outlier_hits,
        last_seen_at = excluded.last_seen_at
    `);

    this.listInfluencersStmt = db.prepare(`
      SELECT ${INFLUENCER_COLUMNS}
      FROM influencers
      ORDER BY avg_virality_score DESC, outlier_hits DESC, author_id ASC
      LIMIT ?
    `);

    this.getFetchStateStmt = db.prepare(`
      SELECT pool, last_tweet_id, last_fetched_at
      FROM fetch_state
      WHERE pool = ?
    `);

    this.setFetchStateStmt = db.prepare(`
      INSERT INTO fetch_state (pool, last_tweet_id, last_fetched_at)
      VALUES (@pool, @lastTweetId, @fetchedAt)
      ON CONFLICT(pool) DO UPDATE SET
        last_tweet_id = excluded.last_tweet_id,
        last_fetched_at = excluded.last_fetched_at
    `);

    this.recordOutlier = db.transaction((input: OutlierInput): Influencer => {
      const existing = this.getInfluencer(input.authorId);
      const outlierHits = existing ? existing.outlierHits + 1 : 1;
      const avgViralityScore = existing
        ? (existing.avgViralityScore * existing.outlierHits + input.viralityScore) / outlierHits
        : input.viralityScore;

      this.upsertInfluencerStmt.run({
        authorId: input.authorId,
        username: input.username,
        followers: input.followers,
        tier: input.tier,
        avgViralityScore,
        outlierHits,
        lastSeenAt: input.seenAt,
      });

      const stored = this.getInfluencer(input.authorId);
      if (!stored) {
        throw new Error(`Failed to store influencer ${input.authorId}`);
      }
      return stored;
    });
  }

  upsertTweet(tweet: NormalizedTweet): void {
    this.upsertTweetStmt.run({
      id: tweet.id,
      pool: tweet.pool,
      authorId: tweet.authorId,
      authorUsername: tweet.authorUsername,
      authorFollowers: tweet.authorFollowers,
      text: tweet.text,
      createdAt: tweet.createdAt,
      likes: tweet.likes,
      retweets: tweet.retweets,
      replies: tweet.replies,
      quotes: tweet.quotes,
      views: tweet.views,
      hasMedia: tweet.hasMedia ? 1 : 0,
      hashtagsJson: JSON.stringify(tweet.hashtags),
      url: tweet.url,
      viralityScore: tweet.viralityScore,
      ingestedAt: tweet.ingestedAt,
    });
  }

  getTweet(id: string): NormalizedTweet | null {
    const row = this.getTweetStmt.get(id) as TweetRow | undefined;
    return row ? mapTweet(row) : null;
  }

  listTweets(): NormalizedTweet[] {
    const rows = this.listTweetsStmt.all() as TweetRow[];
    return rows.map(mapTweet);
  }

  countTweets(): number {
    const count = this.countTweetsStmt.get();
    return typeof count === 'number' ? count : 0;
  }

  upsertInfluencerFromOutlier(input: OutlierInput): Influencer {
    return this.recordOutlier(input);
  }

  getInfluencer(authorId: string): Influencer | null {
    const row = this.getInfluencerStmt.get(authorId) as InfluencerRow | undefined;
    return row ? mapInfluencer(row) : null;
  }

  listInfluencers(limit: number): Influencer[] {
    const rows = this.listInfluencersStmt.all(limit) as InfluencerRow[];
    return rows.map(mapInfluencer);
  }

  getFetchState(pool: PoolName): FetchState | null {
    const row = this.getFetchStateStmt.get(pool) as FetchStateRow | undefined;
    return row ? mapFetchState(row) : null;
  }

  setFetchState(pool: PoolName, lastTweetId: string | null, fetchedAt: string): void {
    this.setFetchStateStmt.run({ pool, lastTweetId, fetchedAt });
  }
}
