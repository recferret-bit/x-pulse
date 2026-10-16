# X-Pulse

X-Pulse watches Indie GameDev and Solana on X, scores what travels, and drafts posts in the Freight Chain voice.

## Core features

- **Ingest** pulls three X searches (indie, Solana, and the overlap) into SQLite and drops spam and reposts.
- **Score** ranks posts by engagement per follower, with a time decay. The top 15% with 1,000–25,000 followers are rising stars. Above 25,000 they are whales.
- **Analyze** sends the scored batch to your local Grok CLI. Grok must follow `workspace/SOUL.md`: mood, style, audience, and the Never list. Telegram gets the digest plus that voice line.
- **Run once** ingests, then analyzes.
- **Daemon** ingests every 3 hours and runs the full digest at 08:00 and 17:00 UTC.
- **Notify** resends the last digest. It does not call X or Grok again. It does repeat the current soul line.
- **Advise** is a one-shot. You describe one post. It samples the last 7 days in three slices, one page each (three TwitterAPI.io requests), including the `Seek` lanes from the soul. Grok writes the drafts for that audience. Hashtags, the UTC time, and the evidence stay computed here. Why is a separate Telegram message.

## How to run

Node.js 22 or newer.

```bash
npm install
cp .env.example .env
```

Required in `.env`: `TWITTER_API_KEY`. Add `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` for Telegram. For Compose, also set `HOST_GROK_BIN_PATH` to your `grok` binary and `GROK_BIN_PATH=grok-build`. Do not set `DB_PATH` or `GROK_WORKSPACE_DIR` for Compose. Those are overridden to `/data/xpulse.db` and `/app/workspace`.

Log in once on the host with `grok login`. The container does not have its own account.

```bash
npm test
npm run build
docker compose up -d --build
```

## Shortcuts

```bash
npm run cli -- ingest
npm run cli -- analyze
npm run cli -- run-once
npm run cli -- daemon
npm run cli -- notify
npm run cli -- advise <what the post is about>
npm test
```

## Soul

`workspace/SOUL.md` is the project. Freight Chain is a browser truck game on Solana: 10 free rides, one mistake ends the shift, a weekly prize pool paid by a program, NFTs, and streamer tools. The voice is meme, hyped, and a little challenging.

Audience: Solana, general web3, web2 gamers, web2 truck-sim players, and young players who want a web3 prize. `Seek` adds `"truck simulator"`, `"solana gaming"`, and `"prize pool"` to advise searches.

`advise` and `analyze` both give this file to Grok. Compose mounts `./workspace` at `/app/workspace`, so an edit to the soul is visible on the next command. A change to the Grok prompt still needs an image rebuild.

## Tests

`npm test` is offline. It uses the mock Twitter server, a mock Telegram Bot API, and `src/harness/mock-grok-cli.sh`. The end-to-end run writes composer links to `workspace/reports/e2e-ready-to-post.md`.

## Docker

```bash
docker compose up -d --build
docker compose exec x-pulse node dist/index.js advise "The road never ends. Your shift does."
docker compose --profile test run --rm x-pulse-test
```

`up -d` starts the daemon in the background. The `exec` line is one advice request. Posts go to Telegram, and the write-up is also in `workspace/reports/advise_latest.md`. The test service does not start unless you pass `--profile test`.

The `x-pulse` service mounts the host `grok` binary from `HOST_GROK_BIN_PATH` at `/usr/local/bin/grok-build`, and the host Grok config directory at `/root/.config/grok`. On this machine the login file is `~/.grok/auth.json`, so that volume has to be `~/.grok:/root/.grok:ro` or Grok inside the container cannot see the session. Grok's working directory is `/app/workspace`, not the repo root. SQLite is the `xpulse_sqlite` volume at `/data/xpulse.db`, not a separate database container.
