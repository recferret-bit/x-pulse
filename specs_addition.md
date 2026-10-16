# SPECIFICATION ADDENDUM: Telegram Tactical Digest & One-Click X Intent Publisher

## 1. Architectural Updates & File Tree Additions
Extend the existing directory structure with the Telegram delivery layer and deterministic HTML/Intent formatters:

```text
x-pulse/
├── src/
│   ├── services/
│   │   ├── x-intent.ts            # Builds URL-encoded [x.com/intent/tweet](https://x.com/intent/tweet) links for 1-click posting & replying
│   │   └── telegram-notifier.ts   # Formats HTML messages + Inline Keyboards and dispatches via Telegram Bot API
└── tests/
    └── unit/
        ├── x-intent.test.ts       # Tests URL encoding, 280-char bounds, and in_reply_to parameter attachment
        └── telegram.test.ts       # Tests HTML escaping, message chunking, and inline_keyboard structure
```

---

## 2. Updated Grok Output Schema (`src/services/grok-runner.ts`)
Update `GrokAnalysisSchema` to require `tweetId` in `replyTargets` so the system can construct direct `in_reply_to` links:

```ts
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
    tweetId: z.string(), // REQUIRED: Exact string ID of the target tweet for Web Intent
    tweetUrl: z.string().url(),
    authorUsername: z.string(),
    tier: z.enum(['rising_star', 'whale']),
    suggestedReply: z.string(),
  })),
});

export type GrokAnalysisResult = z.infer<typeof GrokAnalysisSchema>;
```

---

## 3. Step-by-Step Implementation: Phase 5.5 (Telegram Module)

### Step 1: X Web Intent Link Builder (`src/services/x-intent.ts`)
Implement pure helper functions that generate 1-click publishing URLs without requiring X API Write permissions:

1. **`buildPostIntentUrl(draft: PostDraft): string`**
   - Combines `draft.hook`, double newline, `draft.body`, mentions (`@handle`), and hashtags (`#tag`).
   - Constructs a `URLSearchParams` object with `text=<combined_text>`.
   - Returns `https://x.com/intent/tweet?${params.toString()}`.
2. **`buildReplyIntentUrl(tweetId: string, replyText: string): string`**
   - Constructs `URLSearchParams` with:
     - `in_reply_to`: `tweetId` (triggers native reply composer to that exact tweet on X Web & Mobile app).
     - `text`: `replyText`
   - Returns `https://x.com/intent/tweet?${params.toString()}`.

---

### Step 2: Telegram Digest Formatter & Dispatcher (`src/services/telegram-notifier.ts`)
Use native Node 22 `fetch` to call `https://api.telegram.org/bot${token}/sendMessage` (zero external heavy bot framework dependencies required).

#### Message Splitting Strategy (Avoiding Telegram's 4096-character limit):
Instead of sending one giant wall of text that breaks buttons, split the digest into **3 structured messages** per run:

1. **Message 1: Radar Summary & Hot Trends**
   - **Parse Mode:** `HTML`
   - **Content:**
     - Header with timestamp and optimal UTC posting windows (`optimalPostingWindowsUTC`).
     - Top 3 discovered trends (`indiedev`, `solana`, `intersection`), explaining *Why It Worked* and *Media Format Recommendation*.
2. **Message 2: Ready-to-Publish Post Drafts (1 message per draft or combined with action buttons)**
   - **Parse Mode:** `HTML`
   - **Content:**
     - Best time to post (`bestTimeToPostUTC`).
     - Copy-ready `<pre>` block containing the full tweet text (so the user can also tap-to-copy in Telegram).
     - Recommended media note.
   - **Inline Keyboard (`reply_markup.inline_keyboard`):**
     ```json
     [
       [
         {
           "text": "🚀 Open Draft #1 in X Composer",
           "url": "[https://x.com/intent/tweet?text=](https://x.com/intent/tweet?text=)..."
         }
       ]
     ]
     ```
3. **Message 3: Tactical Reply Targets ("Reply Guy" & Rising Stars)**
   - **Parse Mode:** `HTML`
   - **Content:**
     - List of the 5 target tweets with Influencer Tier badge (`🌟 Rising Star` or `🐋 Whale`), `@username`, and `<pre>` block with the drafted technical reply.
   - **Inline Keyboard (`reply_markup.inline_keyboard`):**
     For each target `i` (1 to 5), render a two-button row:
     ```json
     [
       [
         {
           "text": "🔗 View @author (#1)",
           "url": "[https://x.com/author/status/1234567890](https://x.com/author/status/1234567890)"
         },
         {
           "text": "💬 1-Click Reply (#1)",
           "url": "[https://x.com/intent/tweet?in_reply_to=1234567890&text=](https://x.com/intent/tweet?in_reply_to=1234567890&text=)..."
         }
       ]
     ]
     ```

#### HTML Sanitization Rule:
Implement `escapeTelegramHtml(str: string): string` replacing `&` -> `&amp;`, `<` -> `&lt;`, and `>` -> `&gt;` on all tweet texts, usernames, and AI outputs BEFORE wrapping them in Telegram HTML tags (`<b>`, `<i>`, `<code>`, `<pre>`, `<a href="...">`).

#### Rate Limiting & Resilience:
- Insert a `300ms` delay between sequential `sendMessage` calls.
- If `TELEGRAM_BOT_TOKEN` or `TELEGRAM_CHAT_ID` is not set in `.env`, log a warning and skip Telegram dispatch gracefully without failing the pipeline.

---

## 4. Test Harness Additions (`tests/unit/telegram.test.ts` & `x-intent.test.ts`)
Add the following deterministic tests to the Vitest suite:

1. **Intent URL Encoding Test (`tests/unit/x-intent.test.ts`):**
   - Verify special characters (`#`, `&`, `?`, emojis, newlines) in tweet drafts are properly percent-encoded in `x.com/intent/tweet?text=...`.
   - Verify `in_reply_to` contains the exact string `tweetId` without numeric rounding.
2. **HTML Escaping & Payload Test (`tests/unit/telegram.test.ts`):**
   - Pass a tweet containing `<script> & C++ templates List<T>` into the formatter and verify the output escapes `<`, `>`, and `&` while preserving valid outer `<b>` and `<pre>` tags.
   - Mock global `fetch` via `vi.spyOn(global, 'fetch')` and assert that `TelegramNotifier.sendDigest(sampleGrokOutput)` dispatches valid JSON payloads with `parse_mode: 'HTML'`, `disable_web_page_preview: true`, and valid `inline_keyboard` URL buttons.

---

## 5. CLI Entrypoint Update (`src/index.ts`)
Add a dedicated command to test or re-send the latest generated report to Telegram without re-running `grok-build`:
- `npm run cli -- notify` (Reads `./workspace/output_latest.json` and sends the interactive digest to Telegram).
- Ensure `npm run cli -- analyze`, `run-once`, and `daemon` automatically invoke `TelegramNotifier.sendDigest()` right after `GrokRunner.analyze()` succeeds.