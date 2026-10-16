import { silentLogger, type Logger } from '../logger.js';
import type { GrokAnalysisResult } from './grok-runner.js';
import type { PostAdvice } from './advise.js';
import { buildPostIntentUrl, buildReplyIntentUrl, composePostText } from './x-intent.js';

export function escapeTelegramHtml(input: string): string {
  return input.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export interface InlineButton {
  text: string;
  url: string;
}

export interface TelegramOutboundMessage {
  text: string;
  replyMarkup?: { inline_keyboard: InlineButton[][] };
}

export interface DigestContext {
  optimalPostingWindowsUTC: string[];
  generatedAt: string;
  selectionSummary?: string;
}

const TELEGRAM_TEXT_LIMIT = 4096;
const POOL_ORDER = ['indiedev', 'solana', 'intersection'] as const;

export function chunkTelegramText(text: string, limit = TELEGRAM_TEXT_LIMIT): string[] {
  if (text.length === 0) return [];
  if (limit < 1) {
    throw new Error('Telegram chunk limit must be at least 1');
  }
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + limit, text.length);
    if (end === text.length) {
      chunks.push(text.slice(start));
      break;
    }
    const newlineAt = text.lastIndexOf('\n', end - 1);
    const cut = newlineAt >= start ? newlineAt + 1 : end;
    chunks.push(text.slice(start, cut));
    start = cut;
  }
  return chunks;
}

type Trend = GrokAnalysisResult['trends'][number];
type ReplyTarget = GrokAnalysisResult['replyTargets'][number];

function selectTrends(trends: Trend[]): Trend[] {
  const chosen: Trend[] = [];
  const used = new Set<number>();

  for (const pool of POOL_ORDER) {
    const index = trends.findIndex((trend, trendIndex) => !used.has(trendIndex) && trend.pool === pool);
    if (index === -1) continue;
    used.add(index);
    chosen.push(trends[index]);
  }

  for (let index = 0; index < trends.length && chosen.length < 3; index += 1) {
    if (used.has(index)) continue;
    used.add(index);
    chosen.push(trends[index]);
  }

  return chosen;
}

function stripLeadingAt(username: string): string {
  return username.trim().replace(/^@+/, '');
}

function formatSummary(analysis: GrokAnalysisResult, context: DigestContext): string {
  const lines = [
    '<b>X-Pulse Digest</b>',
    `<i>${escapeTelegramHtml(context.generatedAt)}</i>`,
    '',
    '<b>Optimal posting windows (UTC)</b>',
  ];
  if (context.optimalPostingWindowsUTC.length === 0) {
    lines.push('No timing window yet.');
  } else {
    for (const window of context.optimalPostingWindowsUTC) {
      lines.push(`• ${escapeTelegramHtml(window)}`);
    }
  }
  if (context.selectionSummary && context.selectionSummary.trim().length > 0) {
    lines.push('', '<b>Why these were selected</b>', escapeTelegramHtml(context.selectionSummary));
  }
  lines.push('', '<b>Trends</b>');
  for (const trend of selectTrends(analysis.trends)) {
    lines.push(`<b>${escapeTelegramHtml(trend.pool)} — ${escapeTelegramHtml(trend.topic)}</b>`);
    lines.push(`Why: ${escapeTelegramHtml(trend.whyItWorked)}`);
    lines.push(`Media: ${escapeTelegramHtml(trend.mediaFormatRecommendation)}`);
  }
  return lines.join('\n');
}

function formatDraft(
  draft: GrokAnalysisResult['postDrafts'][number],
  number: number,
  mediaNote: string | undefined,
): string {
  const lines = [
    `<b>Draft #${number}</b>`,
    `Best time: <code>${escapeTelegramHtml(draft.bestTimeToPostUTC)}</code>`,
  ];
  if (mediaNote && mediaNote.trim().length > 0) {
    lines.push(`Media: ${escapeTelegramHtml(mediaNote)}`);
  }
  lines.push(`<pre>${escapeTelegramHtml(composePostText(draft))}</pre>`);
  return lines.join('\n');
}

function tierBadge(tier: ReplyTarget['tier']): string {
  return tier === 'rising_star' ? '🌟 Rising Star' : '🐋 Whale';
}

function formatReplies(targets: ReplyTarget[]): string {
  const lines = ['<b>Tactical replies</b>'];
  for (const target of targets) {
    const username = stripLeadingAt(target.authorUsername);
    lines.push(`<b>${tierBadge(target.tier)}</b> @${escapeTelegramHtml(username)}`);
    lines.push(`<pre>${escapeTelegramHtml(target.suggestedReply)}</pre>`);
  }
  return lines.join('\n');
}

function replyKeyboard(targets: ReplyTarget[]): InlineButton[][] {
  return targets.map((target, index) => {
    const number = index + 1;
    const username = stripLeadingAt(target.authorUsername);
    return [
      { text: `🔗 View @${username} (#${number})`, url: target.tweetUrl },
      { text: `💬 1-Click Reply (#${number})`, url: buildReplyIntentUrl(target.tweetId, target.suggestedReply) },
    ];
  });
}

function toMessages(text: string, keyboard?: InlineButton[][]): TelegramOutboundMessage[] {
  const chunks = chunkTelegramText(text);
  const replyMarkup = keyboard && keyboard.length > 0 ? { inline_keyboard: keyboard } : undefined;
  return chunks.map((chunk, index) => {
    const isLast = index === chunks.length - 1;
    if (isLast && replyMarkup) return { text: chunk, replyMarkup };
    return { text: chunk };
  });
}

export function formatDigestMessages(
  analysis: GrokAnalysisResult,
  context: DigestContext,
): TelegramOutboundMessage[] {
  const messages = toMessages(formatSummary(analysis, context));
  analysis.postDrafts.forEach((draft, index) => {
    const number = index + 1;
    messages.push(
      ...toMessages(formatDraft(draft, number, analysis.trends[index]?.mediaFormatRecommendation), [[
        {
          text: `🚀 Open Draft #${number} in X Composer`,
          url: buildPostIntentUrl(draft),
        },
      ]]),
    );
  });
  const targets = analysis.replyTargets.slice(0, 5);
  messages.push(...toMessages(formatReplies(targets), replyKeyboard(targets)));
  return messages;
}

export function formatAdviseMessages(advice: PostAdvice): TelegramOutboundMessage[] {
  const proposal = [
    '<b>One-shot post advice</b>',
    `Topic: ${escapeTelegramHtml(advice.topic)}`,
    '',
    `<b>${escapeTelegramHtml(advice.title)}</b>`,
    escapeTelegramHtml(advice.content),
    '',
    `<b>When</b>: ${escapeTelegramHtml(advice.bestTimeToPostUTC)} UTC`,
    `<b>Hashtags</b>: ${escapeTelegramHtml(advice.hashtags.map((tag) => `#${tag}`).join(' ') || 'none')}`,
    `<b>Content type</b>: ${escapeTelegramHtml(advice.options.find((option) => option.recommended)?.label ?? advice.contentKind)}`,
    escapeTelegramHtml(advice.mediaNote),
    '',
    '<b>Options</b>',
    ...advice.options.map((option, index) => [
      '',
      `<b>${index + 1}. ${escapeTelegramHtml(option.label)}${option.recommended ? ' (recommended)' : ''}</b>`,
      escapeTelegramHtml(option.reason),
      `<pre>${escapeTelegramHtml(composePostText(optionDraft(advice, option.body)))}</pre>`,
    ].join('\n')),
    '',
    '<b>Why</b>',
    escapeTelegramHtml(advice.why),
  ].join('\n');
  const draftButton: InlineButton[][] = advice.options.map((option, index) => [
    {
      text: `${option.recommended ? '🚀' : '✏️'} Open option #${index + 1}`,
      url: buildPostIntentUrl(optionDraft(advice, option.body)),
    },
  ]);

  const evidenceLines = ['<b>Evidence from similar posts</b>'];
  if (advice.evidence.length === 0) {
    evidenceLines.push('No similar post cleared the spam and repost filters.');
  }
  for (const [index, item] of advice.evidence.entries()) {
    evidenceLines.push(
      '',
      `<b>${index + 1}. @${escapeTelegramHtml(item.authorUsername)}</b>`,
      escapeTelegramHtml(item.reason),
      escapeTelegramHtml(item.url),
    );
  }
  const evidenceButtons: InlineButton[][] = advice.evidence.map((item, index) => [
    { text: `🔗 View @${item.authorUsername} (#${index + 1})`, url: item.url },
  ]);

  return [
    ...toMessages(proposal, draftButton),
    ...toMessages(evidenceLines.join('\n'), evidenceButtons),
  ];
}

export interface TelegramNotifierOptions {
  token?: string;
  chatId?: string;
  /** Origin only, for example https://api.telegram.org. No trailing slash required. */
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  logger?: Logger;
  delayMs?: number;
}

interface SendMessageBody {
  chat_id: string;
  text: string;
  parse_mode: 'HTML';
  disable_web_page_preview: true;
  reply_markup?: { inline_keyboard: InlineButton[][] };
}

function optionDraft(advice: PostAdvice, body: string): {
  hook: string;
  body: string;
  recommendedHashtags: string[];
  accountsToMention: string[];
  bestTimeToPostUTC: string;
} {
  return {
    hook: advice.title,
    body,
    recommendedHashtags: advice.hashtags,
    accountsToMention: advice.mentions,
    bestTimeToPostUTC: advice.bestTimeToPostUTC,
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class TelegramNotifier {
  private readonly token: string | undefined;
  private readonly chatId: string | undefined;
  private readonly apiBaseUrl: string;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly logger: Logger;
  private readonly delayMs: number;

  constructor(options: TelegramNotifierOptions) {
    this.token = options.token;
    this.chatId = options.chatId;
    this.apiBaseUrl = (options.apiBaseUrl ?? 'https://api.telegram.org').replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl;
    this.sleep = options.sleep ?? defaultSleep;
    this.logger = options.logger ?? silentLogger;
    this.delayMs = options.delayMs ?? 300;
  }

  async sendDigest(
    analysis: GrokAnalysisResult,
    context: DigestContext,
  ): Promise<{ skipped: boolean; sent: number }> {
    return this.deliver(formatDigestMessages(analysis, context));
  }

  async sendAdvise(advice: PostAdvice): Promise<{ skipped: boolean; sent: number }> {
    return this.deliver(formatAdviseMessages(advice));
  }

  private async deliver(messages: TelegramOutboundMessage[]): Promise<{ skipped: boolean; sent: number }> {
    const token = this.token?.trim() ?? '';
    const chatId = this.chatId?.trim() ?? '';
    if (token === '' || chatId === '') {
      this.logger.warn('Telegram is not configured');
      return { skipped: true, sent: 0 };
    }

    const doFetch = this.fetchImpl ?? globalThis.fetch;
    for (let index = 0; index < messages.length; index += 1) {
      if (index > 0) await this.sleep(this.delayMs);
      const message = messages[index];
      if (!message) continue;
      const body: SendMessageBody = {
        chat_id: chatId,
        text: message.text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      };
      if (message.replyMarkup) body.reply_markup = message.replyMarkup;

      const response = await doFetch(`${this.apiBaseUrl}/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        throw new Error(`Telegram sendMessage failed with status ${response.status}`);
      }
    }

    return { skipped: false, sent: messages.length };
  }
}
