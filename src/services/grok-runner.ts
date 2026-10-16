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
  'Read ./SOUL.md and ./payload_latest.json. Use parallel subagents to: 1) Deconstruct Indie GameDev viral hooks, 2) Deconstruct Solana ecosystem discussions, 3) Draft 3 high-converting posts, tag strategies, and 5 tactical replies to recent influencer tweets. The same soul rules as advise apply: match Mood and Style, write so every group in Audience feels called out, and do not use anything in Never. Drafts must sound like this project, not a generic analyst. Title, Launch, and Constraint in SOUL.md are the voice, not text to paste blindly. Do not @ accounts just because they appear in the payload. Write valid JSON to ./output_latest.json and markdown to ./reports/digest_latest.md.';

export const GROK_ADVISE_PROMPT =
  'Read ./SOUL.md and ./advise_payload.json. Write only ./advise_output.json. Shape: {"title": string, "options": [{"label": string, "kind": "text"|"image"|"gif"|"video", "body": string, "formatNote": string}]}. Match the SOUL.md mood and style. Write so the Audience in SOUL.md feels called out: Solana and web3 people, web2 gamers, truck-sim players, and young players who want a prize. Do not use anything in Never. body is the tweet text. formatNote is how to shoot it and must not appear inside body. Do not @ accounts from the evidence. Use the payload hashtags and bestTimeToPostUTC. Include one option whose kind equals payload contentKind, plus two different text options aimed at different audiences. No markdown fences.';

export const GrokAdviseSchema = z.object({
  title: z.string().min(1),
  options: z.array(z.object({
    label: z.string().min(1),
    kind: z.enum(['text', 'image', 'gif', 'video']),
    body: z.string().min(1),
    formatNote: z.string().default(''),
  })).min(1).max(6),
});

export type GrokAdviseResult = z.infer<typeof GrokAdviseSchema>;

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

    const { code, stdout, stderr } = await this.spawnGrok(GROK_ANALYZE_PROMPT);
    this.logger.debug('grok process finished', { code, stdout, stderr });

    if (code !== 0) {
      throw new Error(`grok exited with code ${code ?? 'null'}: ${stderr}`);
    }

    const outputPath = path.join(this.workspaceDir, 'output_latest.json');
    const raw = await readFile(outputPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return GrokAnalysisSchema.parse(parsed);
  }

  async advise(payload: unknown): Promise<GrokAdviseResult> {
    await mkdir(this.workspaceDir, { recursive: true });
    const payloadPath = path.join(this.workspaceDir, 'advise_payload.json');
    await writeFile(payloadPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    this.logger.info('starting grok advise', { binPath: this.binPath, workspaceDir: this.workspaceDir });
    const { code, stdout, stderr } = await this.spawnGrok(GROK_ADVISE_PROMPT);
    this.logger.debug('grok advise finished', { code, stdout, stderr });
    if (code !== 0) {
      throw new Error(`grok exited with code ${code ?? 'null'}: ${stderr}`);
    }
    const raw = await readFile(path.join(this.workspaceDir, 'advise_output.json'), 'utf8');
    return GrokAdviseSchema.parse(JSON.parse(raw));
  }

  private spawnGrok(prompt: string): Promise<GrokProcessResult> {
    const binPath = this.binPath;
    const workspaceDir = this.workspaceDir;
    const timeoutMs = this.timeoutMs;
    const logger = this.logger;

    return new Promise((resolve, reject) => {
      const child = spawn(binPath, ['-p', prompt], {
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
