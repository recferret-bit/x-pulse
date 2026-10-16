import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export interface RecordedTelegramButton {
  text: string;
  url: string;
}

export interface RecordedTelegramMessage {
  token: string;
  chatId: string;
  text: string;
  parseMode: string;
  disableWebPagePreview: boolean;
  inlineKeyboard: RecordedTelegramButton[][];
}

export interface MockTelegramServer {
  url: string;
  messages: RecordedTelegramMessage[];
  reset(): void;
  close(): Promise<void>;
}

const SEND_MESSAGE = /^\/bot([^/]+)\/sendMessage$/;

export function startMockTelegramServer(): Promise<MockTelegramServer> {
  const messages: RecordedTelegramMessage[] = [];
  const server = createServer((req, res) => {
    void handleRequest(req, res, messages);
  });

  return new Promise((resolve, reject) => {
    const onListenError = (error: Error) => {
      reject(error);
    };
    server.once('error', onListenError);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', onListenError);
      server.on('error', () => {});
      const address = server.address();
      if (address === null || typeof address === 'string' || address.port === 0) {
        reject(new Error('Mock Telegram server did not bind a TCP port'));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        messages,
        reset() {
          messages.length = 0;
        },
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

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  messages: RecordedTelegramMessage[],
): Promise<void> {
  let pathname = '';
  try {
    pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
  } catch {
    sendJson(res, 400, { ok: false, description: 'bad request' });
    return;
  }

  const match = SEND_MESSAGE.exec(pathname);
  if (req.method !== 'POST' || !match) {
    sendJson(res, 404, { ok: false, description: 'not found' });
    return;
  }

  const token = decodeURIComponent(match[1] ?? '');
  let body: unknown;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    sendJson(res, 400, { ok: false, description: 'invalid json' });
    return;
  }
  if (!isSendBody(body)) {
    sendJson(res, 400, { ok: false, description: 'text and chat_id are required' });
    return;
  }

  messages.push({
    token,
    chatId: body.chat_id,
    text: body.text,
    parseMode: body.parse_mode,
    disableWebPagePreview: body.disable_web_page_preview,
    inlineKeyboard: body.reply_markup?.inline_keyboard ?? [],
  });
  sendJson(res, 200, { ok: true, result: { message_id: messages.length } });
}

function isSendBody(value: unknown): value is {
  chat_id: string;
  text: string;
  parse_mode: string;
  disable_web_page_preview: boolean;
  reply_markup?: { inline_keyboard: RecordedTelegramButton[][] };
} {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.chat_id !== 'string' || typeof record.text !== 'string') return false;
  if (record.parse_mode !== 'HTML') return false;
  if (record.disable_web_page_preview !== true) return false;
  if (record.reply_markup === undefined) return true;
  return isKeyboard(record.reply_markup);
}

function isKeyboard(value: unknown): value is { inline_keyboard: RecordedTelegramButton[][] } {
  if (typeof value !== 'object' || value === null) return false;
  const keyboard = (value as { inline_keyboard?: unknown }).inline_keyboard;
  if (!Array.isArray(keyboard)) return false;
  return keyboard.every(
    (row) =>
      Array.isArray(row) &&
      row.every(
        (button) =>
          typeof button === 'object' &&
          button !== null &&
          typeof (button as { text?: unknown }).text === 'string' &&
          typeof (button as { url?: unknown }).url === 'string',
      ),
  );
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}
