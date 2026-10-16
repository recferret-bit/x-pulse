import { z } from 'zod';

/**
 * grok-build indexes whatever directory it is started in.
 * Callers must spawn it with cwd = GROK_WORKSPACE_DIR, never the repo root
 * (that directory contains .env and src/).
 */
const EnvSchema = z.object({
  TWITTER_API_KEY: z.string().min(1),
  TWITTER_API_BASE_URL: z.string().url().default('https://api.twitterapi.io'),
  DB_PATH: z.string().min(1).default('./data/xradar.db'),
  GROK_WORKSPACE_DIR: z.string().min(1).default('./workspace'),
  GROK_BIN_PATH: z.string().min(1).default('grok-build'),
  TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
  TELEGRAM_CHAT_ID: z.string().min(1).optional(),
  TELEGRAM_API_BASE_URL: z.string().url().default('https://api.telegram.org'),
});

export type Env = z.infer<typeof EnvSchema>;

function blankToUndefined(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = EnvSchema.safeParse({
    TWITTER_API_KEY: blankToUndefined(source.TWITTER_API_KEY),
    TWITTER_API_BASE_URL: blankToUndefined(source.TWITTER_API_BASE_URL),
    DB_PATH: blankToUndefined(source.DB_PATH),
    GROK_WORKSPACE_DIR: blankToUndefined(source.GROK_WORKSPACE_DIR),
    GROK_BIN_PATH: blankToUndefined(source.GROK_BIN_PATH),
    TELEGRAM_BOT_TOKEN: blankToUndefined(source.TELEGRAM_BOT_TOKEN),
    TELEGRAM_CHAT_ID: blankToUndefined(source.TELEGRAM_CHAT_ID),
    TELEGRAM_API_BASE_URL: blankToUndefined(source.TELEGRAM_API_BASE_URL),
  });
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'} ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment: ${detail}`);
  }
  return parsed.data;
}
