import { createServer, IncomingMessage, ServerResponse } from 'http';
import { WebSocketServer } from 'ws';
import { RoomManager } from './rooms.js';
import { handleConnection } from './ws-handler.js';
import { generateTurnCredentials, generateCloudflareIceServers } from './turn.js';
import { computeVolumes, computeVolumesFromRoom } from './volumes.js';
import { TokenBucket, ConcurrencyLimiter, LIMITS, clientIp } from './rate-limit.js';

const PORT = parseInt(process.env.PORT || '3100');
// Cloudflare Realtime TURN (preferred, see docs/SETUP.md). When configured,
// the server fetches ICE credentials from Cloudflare on /turn-credentials.
const TURN_KEY_ID = process.env.TURN_KEY_ID || '';
const TURN_KEY_API_TOKEN = process.env.TURN_KEY_API_TOKEN || '';
// Self-hosted coturn fallback (optional). Used only when the Cloudflare vars
// above are unset — lets operators who'd rather run their own coturn keep
// the existing HMAC flow without code changes.
const TURN_SERVER = process.env.TURN_SERVER || '';
const TURN_SECRET = process.env.TURN_SECRET || '';
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '';

const rooms = new RoomManager();

// Per-endpoint rate limiters keyed by client IP. See rate-limit.ts for the
// rationale behind each limit.
const turnCredsLimiter = new TokenBucket(LIMITS.TURN_CREDS);
const computeVolumesLimiter = new TokenBucket(LIMITS.COMPUTE_VOLUMES);
const wsConnectionLimiter = new ConcurrencyLimiter(LIMITS.WS_PER_IP);

// Prune idle buckets every 5 minutes (drop entries idle for >10 min). Keeps
// memory bounded even if the server sees lots of unique IPs briefly.
setInterval(() => {
  turnCredsLimiter.pruneIdle(10 * 60 * 1000);
  computeVolumesLimiter.pruneIdle(10 * 60 * 1000);
}, 5 * 60 * 1000).unref();

function sendError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: message }));
}

const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
  // CORS headers on all responses
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', rooms: rooms.roomCount }));
    return;
  }

  if (req.method === 'POST' && req.url === '/compute-volumes') {
    if (!computeVolumesLimiter.tryConsume(clientIp(req))) {
      sendError(res, 429, 'rate limit exceeded — slow down');
      return;
    }

    let body = '';
    let aborted = false;
    req.on('data', (chunk: Buffer) => {
      if (aborted) return;
      body += chunk.toString();
      // Bound in-memory buffering so an attacker can't OOM us with a huge POST.
      if (body.length > LIMITS.BODY_BYTES) {
        aborted = true;
        sendError(res, 413, 'request body too large');
        req.destroy();
      }
    });
    req.on('end', async () => {
      if (aborted) return;
      try {
        const parsed = JSON.parse(body);
        // v0.2 path: client passes roomId + name; server reads positions from
        // room state. v0.1 path: client passes 'peers' field with encrypted
        // blobs. Detect by shape — new path is preferred when both happen
        // to be present (shouldn't, but be defensive).
        const result = parsed && typeof parsed === 'object' && typeof parsed.roomId === 'string'
          ? computeVolumesFromRoom(
              parsed,
              (roomId, exceptName, staleMs) => rooms.getRoomPositions(roomId, exceptName, staleMs),
            )
          : await computeVolumes(parsed, ENCRYPTION_KEY);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err: any) {
        sendError(res, 400, err.message || 'Invalid request');
      }
    });
    return;
  }

  if (req.url === '/turn-credentials') {
    if (!turnCredsLimiter.tryConsume(clientIp(req))) {
      sendError(res, 429, 'rate limit exceeded — slow down');
      return;
    }
    // Prefer Cloudflare if both vars are set; fall back to self-hosted coturn
    // HMAC; otherwise return empty iceServers (client falls back to public STUN).
    const credsPromise = TURN_KEY_ID && TURN_KEY_API_TOKEN
      ? generateCloudflareIceServers(TURN_KEY_ID, TURN_KEY_API_TOKEN)
      : generateTurnCredentials(TURN_SERVER, TURN_SECRET);
    credsPromise.then((data) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

// WebSocketServer with a per-message size cap. Real signaling messages (SDP,
// ICE candidates, position blobs) are well under 10 KB; 64 KB gives 6x
// headroom and blocks anyone trying to flood the relay with huge payloads.
const wss = new WebSocketServer({ server: httpServer, maxPayload: LIMITS.WS_PAYLOAD_BYTES });

wss.on('connection', (ws, req) => {
  const ip = clientIp(req as any);
  if (!wsConnectionLimiter.acquire(ip)) {
    console.warn('[ws] rejecting connection from', ip, '— per-IP cap reached');
    ws.close(1008 /* policy violation */, 'too many connections from your IP');
    return;
  }
  ws.on('close', () => wsConnectionLimiter.release(ip));
  handleConnection(ws, rooms);
});

httpServer.listen(PORT, () => {
  console.log(`proxchat-server listening on :${PORT}`);
});
