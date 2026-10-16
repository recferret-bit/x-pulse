import type { PoolName } from '../domain.js';

export interface SearchPool {
  name: PoolName;
  query: string;
}

export const SEARCH_POOLS: readonly SearchPool[] = [
  {
    name: 'indiedev',
    query:
      '(#indiedev OR #gamedev OR #screenshotsaturday OR "wishlist on steam" OR "indie game") min_faves:25 -is:retweet lang:en',
  },
  {
    name: 'solana',
    query:
      '("solana" OR #solana OR "solana gaming" OR "web3 gaming") min_faves:40 -airdrop -giveaway -pump -presale -whitelist -"$SOL" -is:retweet lang:en',
  },
  {
    name: 'intersection',
    query:
      '("indie game" OR #gamedev) AND ("solana" OR "onchain" OR "web3" OR "multiplayer backend") min_faves:10 -is:retweet lang:en',
  },
];

const SPAM_PATTERNS: readonly RegExp[] = [
  /\bairdrop\b/i,
  /\bgiveaway\b/i,
  /\bpump\b/i,
  /\bpresale\b/i,
  /\bwhitelist\b/i,
  /\$sol\b/i,
];

export function isSpamText(text: string): boolean {
  return SPAM_PATTERNS.some((pattern) => pattern.test(text));
}

export function isRetweetText(text: string): boolean {
  return /^RT\s+@/i.test(text.trim());
}
