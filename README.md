# X-Pulse

X-Pulse watches Indie GameDev and Solana on X, scores what travels, and tells you how to post.

## Core features

- **Ingest** pulls three X searches (indie, Solana, and the overlap) into SQLite and drops spam and reposts.
- **Score** ranks posts by engagement per follower, with a time decay. The top 15% with 1,000–25,000 followers are rising stars. Above 25,000 they are whales.
- **Analyze** sends the scored batch to `grok-build` and delivers a Telegram digest with composer buttons.
- **Run once** ingests, then analyzes.
- **Daemon** ingests every 3 hours and runs the full digest at 08:00 and 17:00 UTC.
- **Notify** resends the last digest without calling X or `grok-build` again.
- **Advise** is a one-shot. You describe one post. It searches X for similar posts and returns the content type, a few copy and format options (text variants, image, GIF, video), hashtags, and a UTC time, each with the posts that justify it.

## How to run

Node.js 22 or newer.

```bash
npm install
cp .env.example .env
```

Put `TWITTER_API_KEY` in `.env`. Add `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` when you want Telegram delivery. `advise` calls TwitterAPI.io for real on your machine. The test suite does not.

```bash
npm run cli -- advise I shipped a torch-falloff GIF and Steam wishlists jumped
npm test
npm run build
docker compose up --build
```

`grok-build` must run with its working directory set to `./workspace`, not the repo root, so it does not index `.env`.

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

`advise` writes the same recommendation to `workspace/reports/advise_latest.md`. `notify` resends `workspace/output_latest.json`.

## Tests

`npm test` is offline. It uses the mock Twitter server, a mock Telegram Bot API, and `src/harness/mock-grok-cli.sh`. The end-to-end run writes composer links to `workspace/reports/e2e-ready-to-post.md`.

## Docker

```bash
docker compose up -d --build
docker compose exec x-pulse node dist/index.js advise "I shipped a torch-falloff GIF and Steam wishlists jumped"
docker compose --profile test run --rm x-pulse-test
```

`up -d` starts the daemon in the background. The `exec` line is a one-shot advice request. The same text is sent to Telegram and written to `workspace/reports/advise_latest.md`.

The `x-pulse` service mounts host Grok auth from `~/.config/grok` and the `grok-build` binary from `HOST_GROK_BIN_PATH` (default `/usr/local/bin/grok-build`). Inside the container the binary still runs with cwd `/app/workspace` (the mounted `./workspace` directory), so it does not index `.env`. SQLite lives on the `xpulse_sqlite` volume at `/data/xpulse.db`.
