import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export interface MockTwitterFixture {
  indiedev: { tweets: unknown[]; has_next_page: boolean; next_cursor: string };
  solana: { tweets: unknown[]; has_next_page: boolean; next_cursor: string };
  intersection: { tweets: unknown[]; has_next_page: boolean; next_cursor: string };
}

export interface MockTwitterServer {
  url: string;
  close(): Promise<void>;
}

type FixturePage = MockTwitterFixture['indiedev'];

const SEARCH_PATH = '/twitter/tweet/advanced_search';

export function loadTwitterFixture(path: string): MockTwitterFixture {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isMockTwitterFixture(parsed)) {
    throw new Error(`Invalid Twitter fixture at ${path}`);
  }
  return parsed;
}

export function startMockTwitterServer(fixture: MockTwitterFixture): Promise<MockTwitterServer> {
  const server = createServer((req, res) => {
    handleRequest(req, res, fixture);
  });

  return new Promise((resolve, reject) => {
    const onListenError = (error: Error) => {
      reject(error);
    };
    server.once('error', onListenError);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', onListenError);
      // 'error' with no listener crashes the process. Listen failures are handled above.
      server.on('error', () => {});
      const address = server.address();
      if (address === null || typeof address === 'string' || address.port === 0) {
        reject(new Error('Mock Twitter server did not bind a TCP port'));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => shutdown(server),
      });
    });
  });
}

function shutdown(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
    server.closeAllConnections();
  });
}

function handleRequest(req: IncomingMessage, res: ServerResponse, fixture: MockTwitterFixture): void {
  let pathname = '';
  let query = '';
  try {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    pathname = url.pathname;
    query = url.searchParams.get('query') ?? '';
  } catch {
    sendJson(res, 400, { error: 'bad request' });
    return;
  }

  if (req.method !== 'GET' || !pathname.endsWith(SEARCH_PATH)) {
    sendJson(res, 404, { error: 'not found' });
    return;
  }

  const apiKey = readHeader(req.headers['x-api-key']);
  if (apiKey.trim() === '') {
    sendJson(res, 401, { error: 'missing api key' });
    return;
  }

  // Intersection is matched before min_faves:40 so a combined query cannot fall through to solana.
  const page = selectPage(query, fixture);
  sendJson(res, 200, {
    tweets: page.tweets,
    has_next_page: page.has_next_page,
    next_cursor: page.next_cursor,
  });
}

function selectPage(query: string, fixture: MockTwitterFixture): FixturePage {
  if (query.includes('multiplayer backend')) return fixture.intersection;
  if (query.includes('min_faves:40')) return fixture.solana;
  return fixture.indiedev;
}

function readHeader(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function isPage(value: unknown): value is FixturePage {
  if (typeof value !== 'object' || value === null) return false;
  const page = value as Record<string, unknown>;
  return Array.isArray(page.tweets) && typeof page.has_next_page === 'boolean' && typeof page.next_cursor === 'string';
}

function isMockTwitterFixture(value: unknown): value is MockTwitterFixture {
  if (typeof value !== 'object' || value === null) return false;
  const fixture = value as Record<string, unknown>;
  return isPage(fixture.indiedev) && isPage(fixture.solana) && isPage(fixture.intersection);
}
