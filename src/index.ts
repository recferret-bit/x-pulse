import { pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import type Database from 'better-sqlite3';
import { loadEnv } from './config/env.js';
import { openDatabase } from './db/client.js';
import { TweetRepository } from './db/repository.js';
import { createLogger } from './logger.js';
import { readAdviseBrief, renderAdviceMarkdown, runAdvise } from './services/advise.js';
import { analyze, ingest, notify, runOnce, startDaemon } from './pipeline.js';
import { GrokRunner } from './services/grok-runner.js';
import { TelegramNotifier } from './services/telegram-notifier.js';
import { TwitterApiClient } from './services/twitter-api.js';

const HELP = `Usage: x-pulse <command>

Commands:
  ingest     Fetch TwitterAPI.io pools and update SQLite
  analyze    Build the payload, run grok-build -p, send Telegram
  run-once   Ingest, then analyze
  daemon     Ingest every 3h; Grok digest at 08:00 and 17:00 UTC
  notify     Re-send workspace/output_latest.json to Telegram
  advise     One-shot: search X for similar posts and send a draft to Telegram
`;

type Command = 'ingest' | 'analyze' | 'run-once' | 'daemon' | 'notify' | 'advise';

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

function parseCommand(argv: string | undefined): Command | 'help' | 'invalid' {
  if (argv === undefined || argv === 'help' || argv === '--help' || argv === '-h') return 'help';
  if (
    argv === 'ingest' ||
    argv === 'analyze' ||
    argv === 'run-once' ||
    argv === 'daemon' ||
    argv === 'notify' ||
    argv === 'advise'
  ) {
    return argv;
  }
  return 'invalid';
}

export async function main(): Promise<void> {
  const command = parseCommand(process.argv[2]);
  if (command === 'help') {
    process.stdout.write(HELP);
    process.exit(0);
  }
  if (command === 'invalid') {
    process.stderr.write(HELP);
    process.exit(1);
  }

  dotenv.config();

  let db: Database.Database | undefined;
  try {
    const env = loadEnv();
    const logger = createLogger(process.env.LOG_LEVEL ?? 'info');
    db = openDatabase(env.DB_PATH);
    const repository = new TweetRepository(db);
    const twitter = new TwitterApiClient({
      apiKey: env.TWITTER_API_KEY,
      baseUrl: env.TWITTER_API_BASE_URL,
      logger,
    });
    const grok = new GrokRunner({
      binPath: env.GROK_BIN_PATH,
      workspaceDir: env.GROK_WORKSPACE_DIR,
      logger,
    });
    const telegram = new TelegramNotifier({
      token: env.TELEGRAM_BOT_TOKEN,
      chatId: env.TELEGRAM_CHAT_ID,
      apiBaseUrl: env.TELEGRAM_API_BASE_URL,
      logger,
    });
    const deps = { env, db, twitter, repository, grok, telegram, logger };

    if (command === 'daemon') {
      const handle = startDaemon(deps);
      let stopping = false;
      const shutdown = (): void => {
        if (stopping) return;
        stopping = true;
        try {
          handle.stop();
          db?.close();
        } finally {
          process.exit(0);
        }
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      return;
    }

    if (command === 'ingest') await ingest(deps);
    else if (command === 'analyze') await analyze(deps);
    else if (command === 'run-once') await runOnce(deps);
    else if (command === 'notify') await notify(deps);
    else {
      const brief = readAdviseBrief(process.argv);
      if (!brief) throw new Error('Usage: x-pulse advise <what the post is about>');
      const advice = await runAdvise({
        brief,
        twitter,
        telegram,
        grok,
        logger,
        workspaceDir: env.GROK_WORKSPACE_DIR,
      });
      process.stdout.write(`${renderAdviceMarkdown(advice)}\n`);
    }

    db.close();
    process.exit(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    try {
      db?.close();
    } catch {
      // The original failure is already reported.
    }
    process.exit(1);
  }
}

if (invokedDirectly()) {
  void main();
}
