# X-Radar

X-Radar ingests Indie GameDev and Solana posts from X, scores them for virality, and asks `grok-build` for a tactical digest. The digest is sent to Telegram with buttons that open an X composer for the drafted posts and replies.

## Setup

Node.js 22 or newer.

```bash
npm install
cp .env.example .env
```

Set `TWITTER_API_KEY`. `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are optional; if either is empty, Telegram delivery is skipped. Point `GROK_BIN_PATH` at `grok-build` if it is not already on `PATH`.

`grok-build` runs with its working directory set to `GROK_WORKSPACE_DIR` (`./workspace`). It must not be started in the repo root, because it indexes that directory and would pick up `.env`.

## CLI

```bash
npm run cli -- ingest
npm run cli -- analyze
npm run cli -- run-once
npm run cli -- daemon
npm run cli -- notify
```

```
Usage: x-radar <command>

Commands:
  ingest     Fetch TwitterAPI.io pools and update SQLite
  analyze    Build the payload, run grok-build -p, send Telegram
  run-once   Ingest, then analyze
  daemon     Ingest every 3h; Grok digest at 08:00 and 17:00 UTC
  notify     Re-send workspace/output_latest.json to Telegram
```

`notify` re-sends the last digest from `workspace/output_latest.json`. It does not call `grok-build` or Twitter again.

`daemon` registers two UTC schedules. Ingest runs at minute 0 of every third hour. A full ingest plus Grok digest runs at 08:00 and 17:00. Those hours sit off the 3-hour grid, so the two jobs do not start together. A run still in progress is skipped instead of overlapping.

## Tests

`npm test` is offline. It uses the mock Twitter server, a mock Telegram Bot API, and `src/harness/mock-grok-cli.sh`. The end-to-end run writes composer links to `workspace/reports/e2e-ready-to-post.md`.

## Docker

```bash
docker compose up --build
docker compose --profile test run --rm x-radar-test
```

The `x-radar` service mounts host Grok auth from `~/.config/grok` and the `grok-build` binary from `HOST_GROK_BIN_PATH` (default `/usr/local/bin/grok-build`). Inside the container the binary still runs with cwd `/app/workspace` (the mounted `./workspace` directory), so it does not index `.env`. SQLite lives on the `xradar_sqlite` volume at `/data/xradar.db`.
