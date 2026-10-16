CREATE TABLE IF NOT EXISTS tweets (
  id TEXT PRIMARY KEY,
  pool TEXT NOT NULL, -- 'indiedev' | 'solana' | 'intersection'
  author_id TEXT NOT NULL,
  author_username TEXT NOT NULL,
  author_followers INTEGER NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  likes INTEGER DEFAULT 0,
  retweets INTEGER DEFAULT 0,
  replies INTEGER DEFAULT 0,
  quotes INTEGER DEFAULT 0,
  views INTEGER DEFAULT 0,
  has_media INTEGER DEFAULT 0,
  hashtags_json TEXT NOT NULL, -- JSON array of strings
  url TEXT NOT NULL,
  virality_score REAL NOT NULL,
  ingested_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tweets_virality ON tweets(virality_score DESC);
CREATE INDEX IF NOT EXISTS idx_tweets_created ON tweets(created_at DESC);

CREATE TABLE IF NOT EXISTS influencers (
  author_id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  followers INTEGER NOT NULL,
  tier TEXT NOT NULL, -- 'rising_star' (1k-25k) | 'whale' (25k+)
  avg_virality_score REAL NOT NULL,
  outlier_hits INTEGER DEFAULT 1,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fetch_state (
  pool TEXT PRIMARY KEY,
  last_tweet_id TEXT,
  last_fetched_at TEXT NOT NULL
);
