FROM node:22-bookworm-slim

# better-sqlite3 needs a native toolchain. curl, ca-certificates, and git
# are available for grok-build and HTTPS fetches inside the image.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    curl \
    ca-certificates \
    git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json vitest.config.ts ./
COPY src ./src
COPY tests ./tests
COPY workspace ./workspace

RUN npm run build && chmod +x src/harness/mock-grok-cli.sh

CMD ["node", "dist/index.js", "daemon"]
