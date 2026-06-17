import type { IncomingMessage, ServerResponse } from 'http';
import type { RoomManager } from './rooms.js';

export interface AdminLogEntry {
  id: number;
  ts: number;
  level: 'info' | 'warn';
  message: string;
  clientId?: string;
  roomId?: string;
  name?: string;
  label?: string;
  ip?: string;
}

export interface AdminClient {
  clientId: string;
  label: string | null;
  roomId: string | null;
  name: string | null;
  team: string | null;
  connectedAt: number;
}

export class EventLog {
  private entries: AdminLogEntry[] = [];
  private nextId = 1;
  private readonly maxEntries: number;

  constructor(maxEntries = 500) {
    this.maxEntries = maxEntries;
  }

  info(message: string, extra: Partial<AdminLogEntry> = {}): void {
    this.append('info', message, extra);
  }

  warn(message: string, extra: Partial<AdminLogEntry> = {}): void {
    this.append('warn', message, extra);
  }

  private append(level: 'info' | 'warn', message: string, extra: Partial<AdminLogEntry>): void {
    const entry: AdminLogEntry = {
      id: this.nextId++,
      ts: Date.now(),
      level,
      message,
      ...extra,
    };
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }
    const prefix = level === 'warn' ? '[warn]' : '[info]';
    console.log(`${prefix} ${message}`);
  }

  since(afterId: number): AdminLogEntry[] {
    if (afterId <= 0) return [...this.entries];
    return this.entries.filter((e) => e.id > afterId);
  }
}

function adminToken(): string | undefined {
  const t = process.env.ADMIN_TOKEN?.trim();
  return t || undefined;
}

export function isAdminAuthorized(req: IncomingMessage): boolean {
  const expected = adminToken();
  if (!expected) return false;
  const raw = req.headers['x-admin-token'];
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (header === expected) return true;
  const auth = req.headers.authorization;
  const bearer = Array.isArray(auth) ? auth[0] : auth;
  return bearer === `Bearer ${expected}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
      if (body.length > 16_384) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

export async function handleAdminRequest(
  req: IncomingMessage,
  res: ServerResponse,
  rooms: RoomManager,
  eventLog: EventLog,
): Promise<boolean> {
  const url = req.url ?? '';
  if (!url.startsWith('/admin/')) return false;

  if (!isAdminAuthorized(req)) {
    sendJson(res, 401, { error: 'unauthorized' });
    return true;
  }

  if (req.method === 'GET' && url.startsWith('/admin/status')) {
    sendJson(res, 200, {
      roomCount: rooms.roomCount,
      clients: rooms.listClients(),
    });
    return true;
  }

  if (req.method === 'GET' && url.startsWith('/admin/logs')) {
    const parsed = new URL(url, 'http://localhost');
    const after = parseInt(parsed.searchParams.get('after') ?? '0', 10) || 0;
    sendJson(res, 200, { logs: eventLog.since(after) });
    return true;
  }

  if (req.method === 'POST' && url === '/admin/kick') {
    try {
      const body = await readJsonBody(req) as { clientId?: string };
      if (!body.clientId?.trim()) {
        sendJson(res, 400, { error: 'clientId required' });
        return true;
      }
      const kicked = rooms.kick(body.clientId.trim(), eventLog);
      if (!kicked) {
        sendJson(res, 404, { error: 'client not found' });
        return true;
      }
      sendJson(res, 200, { ok: true });
    } catch (e: any) {
      sendJson(res, 400, { error: e.message || 'invalid request' });
    }
    return true;
  }

  sendJson(res, 404, { error: 'not found' });
  return true;
}
