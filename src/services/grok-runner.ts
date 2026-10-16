import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { GrokPayload } from '../domain.js';
import { silentLogger, type Logger } from '../logger.js';

export const GrokAnalysisSchema = z.object({
  trends: z.array(z.object({
    pool: z.enum(['indiedev', 'solana', 'intersection']),
    topic: z.string(),
    whyItWorked: z.string(),
    mediaFormatRecommendation: z.string(),
  })),
  postDrafts: z.array(z.object({
    hook: z.string(),
    body: z.string(),
    recommendedHashtags: z.array(z.string()).max(3),
    accountsToMention: z.array(z.string()),
    bestTimeToPostUTC: z.string(),
  })),
  replyTargets: z.array(z.object({
    tweetId: z.string(),
    tweetUrl: z.string().url(),
    authorUsername: z.string(),
    tier: z.enum(['rising_star', 'whale']),
    suggestedReply: z.string(),
  })),
});

export type GrokAnalysisResult = z.infer<typeof GrokAnalysisSchema>;
export type Trend = GrokAnalysisResult['trends'][number];
export type PostDraft = GrokAnalysisResult['postDrafts'][number];
export type ReplyTarget = GrokAnalysisResult['replyTargets'][number];

export const GROK_ANALYZE_PROMPT =
  'Read ./payload_latest.json. Use parallel subagents to: 1) Deconstruct Indie GameDev viral hooks, 2) Deconstruct Solana ecosystem discussions, 3) Draft 3 high-converting posts, tag strategies, and 5 tactical replies to recent influencer tweets. Write valid JSON to ./output_latest.json and markdown to ./reports/digest_latest.md.';

export interface GrokRunnerOptions {
  binPath: string;
  workspaceDir: string;
  timeoutMs?: number;
  logger?: Logger;
}

interface GrokProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export class GrokRunner {
  private readonly binPath: string;
  private readonly workspaceDir: string;
  private readonly timeoutMs: number;
  private readonly logger: Logger;

  constructor(options: GrokRunnerOptions) {
    this.binPath = options.binPath;
    this.workspaceDir = options.workspaceDir;
    this.timeoutMs = options.timeoutMs ?? 180_000;
    this.logger = options.logger ?? silentLogger;
  }

  async analyze(payload: GrokPayload): Promise<GrokAnalysisResult> {
    const reportsDir = path.join(this.workspaceDir, 'reports');
    await mkdir(this.workspaceDir, { recursive: true });
    await mkdir(reportsDir, { recursive: true });

    const payloadPath = path.join(this.workspaceDir, 'payload_latest.json');
    await writeFile(payloadPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

    this.logger.info('starting grok analyze', {
      binPath: this.binPath,
      workspaceDir: this.workspaceDir,
      timeoutMs: this.timeoutMs,
    });

    const { code, stdout, stderr } = await this.spawnAnalyze();
    this.logger.debug('grok process finished', { code, stdout, stderr });

    if (code !== 0) {
      throw new Error(`grok exited with code ${code ?? 'null'}: ${stderr}`);
    }

    const outputPath = path.join(this.workspaceDir, 'output_latest.json');
    const raw = await readFile(outputPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return GrokAnalysisSchema.parse(parsed);
  }

  private spawnAnalyze(): Promise<GrokProcessResult> {
    const binPath = this.binPath;
    const workspaceDir = this.workspaceDir;
    const timeoutMs = this.timeoutMs;
    const logger = this.logger;

    return new Promise((resolve, reject) => {
      const child = spawn(binPath, ['-p', GROK_ANALYZE_PROMPT], {
        cwd: workspaceDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });

      let stdout = '';
      let stderr = '';
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        logger.warn('grok analyze timed out', { timeoutMs });
        try {
          child.kill('SIGKILL');
        } catch (error) {
          logger.warn('failed to SIGKILL grok', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        reject(new Error(`grok analyze timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };

      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk) => {
        stdout += String(chunk);
      });
      child.stderr?.on('data', (chunk) => {
        stderr += String(chunk);
      });

      child.on('error', (error: Error) => {
        finish(() => {
          reject(error);
        });
      });

      child.on('close', (code) => {
        finish(() => {
          resolve({ code, stdout, stderr });
        });
      });
    });
  }
}
