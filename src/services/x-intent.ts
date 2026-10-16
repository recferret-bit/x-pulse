export interface PostDraftInput {
  hook: string;
  body: string;
  recommendedHashtags: string[];
  accountsToMention: string[];
  bestTimeToPostUTC: string;
}

const TWEET_CODE_POINT_LIMIT = 280;

function truncateCodePoints(text: string, limit = TWEET_CODE_POINT_LIMIT): string {
  return [...text].slice(0, limit).join('');
}

function mentionsLine(accounts: string[]): string {
  return accounts
    .map((account) => account.trim().replace(/^@+/, ''))
    .filter((account) => account.length > 0)
    .map((account) => `@${account}`)
    .join(' ');
}

function hashtagsLine(tags: string[]): string {
  return tags
    .map((tag) => tag.trim().replace(/^#+/, ''))
    .filter((tag) => tag.length > 0)
    .map((tag) => `#${tag}`)
    .join(' ');
}

export function composePostText(draft: PostDraftInput): string {
  const mentions = mentionsLine(draft.accountsToMention);
  const hashtags = hashtagsLine(draft.recommendedHashtags);
  let text = `${draft.hook}\n\n${draft.body}`;
  if (mentions) text += `\n\n${mentions}`;
  if (hashtags) text += `\n${hashtags}`;
  return truncateCodePoints(text);
}

export function buildPostIntentUrl(draft: PostDraftInput): string {
  const params = new URLSearchParams({ text: composePostText(draft) });
  return `https://x.com/intent/tweet?${params.toString()}`;
}

export function buildReplyIntentUrl(tweetId: string, replyText: string): string {
  const params = new URLSearchParams({
    in_reply_to: tweetId,
    text: truncateCodePoints(replyText),
  });
  return `https://x.com/intent/tweet?${params.toString()}`;
}
