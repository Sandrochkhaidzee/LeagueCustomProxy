import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { WebSocket } from 'ws';

// End-to-end integration test: spawns the ACTUAL built server (dist/index.js)
// as a subprocess and drives it with real WebSocket + HTTP clients. Unit
// tests cover the volume math with injected getters; this proves the full
// chain wires up — WS join (team) → WS coords (hearCrossTeam) → HTTP
// /compute-volumes (tiered math) — against a real running process.
//
// Requires a build first (`npm run build`). The vitest config / CI should
// run build before this. If dist/ is stale the test exercises stale code,
// so always build immediately before.

const PORT = 31999;
const BASE = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}`;
// Valid 64-hex key so the (unused-in-tiered-path) ENCRYPTION_KEY import is happy.
const TEST_KEY = 'a'.repeat(64);

let server: ChildProcess;

function waitForListening(proc: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start in time')), 10_000);
    proc.stdout?.on('data', (buf: Buffer) => {
      if (buf.toString().includes('listening on')) {
        clearTimeout(timer);
        resolve();
      }
    });
    proc.on('exit', (code) => reject(new Error(`server exited early with code ${code}`)));
  });
}

/** Open a WS, join a room with a team, resolve once room_state is received. */
function joinRoom(room: string, name: string, team: 'ORDER' | 'CHAOS'): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const timer = setTimeout(() => reject(new Error(`${name} join timed out`)), 5000);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'join', room, name, team }));
    });
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'room_state') {
        clearTimeout(timer);
        resolve(ws);
      }
    });
    ws.on('error', reject);
  });
}

function sendCoords(ws: WebSocket, x: number, y: number, hearCrossTeam: boolean): void {
  ws.send(JSON.stringify({ type: 'coords', x, y, hearCrossTeam }));
}

async function computeVolumes(myPosition: { x: number; y: number }, roomId: string, name: string) {
  const resp = await fetch(`${BASE}/compute-volumes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ myPosition, roomId, name }),
  });
  expect(resp.ok).toBe(true);
  return resp.json() as Promise<{ myBlob: string; peerVolumes: Record<string, number> }>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  server = spawn('node', ['dist/index.js'], {
    env: { ...process.env, PORT: String(PORT), ENCRYPTION_KEY: TEST_KEY },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForListening(server);
}, 15_000);

afterAll(() => {
  server?.kill('SIGKILL');
});

describe('tiered proximity — end-to-end against the real server', () => {
  it('serves the v0.3 tiered path (myBlob is empty) for room-shaped requests', async () => {
    const result = await computeVolumes({ x: 0, y: 0 }, 'solo-room', 'Nobody');
    expect(result.myBlob).toBe('');
    expect(result.peerVolumes).toEqual({});
  });

  it('allies are always audible at 1.0; cross-team obeys the 600u default cap', async () => {
    const room = 'r-tiered';
    const alice = await joinRoom(room, 'Alice', 'ORDER');
    const ally = await joinRoom(room, 'AllyFar', 'ORDER');
    const enemyClose = await joinRoom(room, 'EnemyClose', 'CHAOS');
    const enemyFar = await joinRoom(room, 'EnemyFar', 'CHAOS');

    // Alice at origin, toggle OFF (default 600u cross-team cap)
    sendCoords(alice, 0, 0, false);
    // Ally far away — distance shouldn't matter for same-team
    sendCoords(ally, 9000, 9000, false);
    // Enemy within 600u → audible
    sendCoords(enemyClose, 400, 0, false);
    // Enemy beyond 600u but within 1200u → NOT audible (toggle off)
    sendCoords(enemyFar, 800, 0, false);

    await sleep(150); // let the coords WS messages land in room state

    const result = await computeVolumes({ x: 0, y: 0 }, room, 'Alice');
    expect(result.peerVolumes.AllyFar).toBe(1.0);          // ally, always full
    expect(result.peerVolumes.EnemyClose).toBeGreaterThan(0); // < 600u
    expect(result.peerVolumes.EnemyFar).toBeUndefined();   // > 600u, toggle off

    alice.close(); ally.close(); enemyClose.close(); enemyFar.close();
  });

  it('toggling hearCrossTeam ON extends the cross-team range to 1200u', async () => {
    const room = 'r-toggle';
    const alice = await joinRoom(room, 'Alice', 'ORDER');
    const enemyMid = await joinRoom(room, 'EnemyMid', 'CHAOS');

    // Enemy at 800u — beyond the 600u default, inside the 1200u extended range
    sendCoords(enemyMid, 800, 0, false);

    // First: toggle OFF → not audible
    sendCoords(alice, 0, 0, false);
    await sleep(150);
    let result = await computeVolumes({ x: 0, y: 0 }, room, 'Alice');
    expect(result.peerVolumes.EnemyMid).toBeUndefined();

    // Now: toggle ON via a fresh coords message → audible on next compute
    sendCoords(alice, 0, 0, true);
    await sleep(150);
    result = await computeVolumes({ x: 0, y: 0 }, room, 'Alice');
    expect(result.peerVolumes.EnemyMid).toBeGreaterThan(0);

    alice.close(); enemyMid.close();
  });

  it('legacy v0.1 clients (no team on join) still get team-blind volumes', async () => {
    const room = 'r-legacy';
    // Join WITHOUT a team field — simulates a v0.2.x client
    const a = await new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(WS_URL);
      const t = setTimeout(() => reject(new Error('legacy join timeout')), 5000);
      ws.on('open', () => ws.send(JSON.stringify({ type: 'join', room, name: 'Legacy' })));
      ws.on('message', (d) => { if (JSON.parse(d.toString()).type === 'room_state') { clearTimeout(t); resolve(ws); } });
      ws.on('error', reject);
    });
    const other = await joinRoom(room, 'OtherTeamless', 'CHAOS');

    sendCoords(a, 0, 0, false);
    // Teamless requester: legacy fallback uses 1200u team-blind. Place the
    // other peer at 1000u — within 1200u, beyond the 600u tiered default.
    sendCoords(other, 1000, 0, false);
    await sleep(150);

    const result = await computeVolumes({ x: 0, y: 0 }, room, 'Legacy');
    // Even though Legacy never sent a team, the other peer at 1000u is audible
    // because the legacy path ignores teams and uses the full 1200u range.
    expect(result.peerVolumes.OtherTeamless).toBeGreaterThan(0);

    a.close(); other.close();
  });
});
