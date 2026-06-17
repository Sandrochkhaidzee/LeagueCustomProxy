import type { WebSocket } from 'ws';
import type { ClientMessage, ServerMessage } from './types.js';
import type { RoomManager } from './rooms.js';
import type { EventLog } from './admin.js';
import { TokenBucket, LIMITS } from './rate-limit.js';

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function sendError(ws: WebSocket, message: string): void {
  send(ws, { type: 'error', message });
}

export function handleConnection(
  ws: WebSocket,
  rooms: RoomManager,
  eventLog: EventLog,
  clientId: string,
): void {
  // Per-connection message rate limiter. Each WebSocket gets its own bucket
  // so a single noisy client can't block a normal one. Capacity matches the
  // ~10 Hz position-broadcast cadence plus signaling bursts at game start.
  const msgLimiter = new TokenBucket(LIMITS.WS_MESSAGES);
  const limitKey = 'self'; // single bucket per connection — key is irrelevant

  ws.on('message', (data) => {
    if (!msgLimiter.tryConsume(limitKey)) {
      sendError(ws, 'message rate limit exceeded — slow down');
      return;
    }
    let msg: ClientMessage;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      sendError(ws, 'Invalid JSON');
      return;
    }

    switch (msg.type) {
      case 'hello': {
        const label = msg.label?.trim();
        if (!label || label.length > 24) {
          sendError(ws, 'hello requires label (1–24 characters)');
          return;
        }
        rooms.setLabel(ws, label);
        eventLog.info(`${label} connected`, { clientId, label });
        break;
      }

      case 'join': {
        if (!msg.room || !msg.name) {
          sendError(ws, 'join requires room and name');
          return;
        }

        // If already in a room, leave first
        const existing = rooms.getClientInfo(ws);
        if (existing) {
          rooms.leave(ws);
          const others = rooms.getOthersInRoom(ws);
          for (const peer of others) {
            send(peer.ws, { type: 'peer_left', name: existing.name });
          }
        }

        // v0.3: optional team field. v0.2.x clients omit it; we pass undefined
        // and computeTieredVolumes falls back to legacy team-blind behavior.
        const team = msg.team === 'ORDER' || msg.team === 'CHAOS' ? msg.team : undefined;
        const peers = rooms.join(msg.room, msg.name, ws, team);

        const pending = rooms.getConnectionMeta(ws);
        const displayLabel = pending?.label;
        eventLog.info(
          displayLabel
            ? `${displayLabel} joined as ${msg.name} in room ${msg.room}${team ? ` (${team})` : ''}`
            : `${msg.name} joined room ${msg.room}${team ? ` (${team})` : ''}`,
          {
            clientId,
            roomId: msg.room,
            name: msg.name,
            label: displayLabel ?? undefined,
          },
        );

        // Send room_state to the joiner
        send(ws, { type: 'room_state', peers });

        // Broadcast peer_joined to others already in the room
        const others = rooms.getOthersInRoom(ws);
        for (const peer of others) {
          send(peer.ws, { type: 'peer_joined', name: msg.name });
        }
        break;
      }

      case 'signal': {
        const info = rooms.getClientInfo(ws);
        if (!info) {
          sendError(ws, 'Not in a room');
          return;
        }
        if (!msg.to) {
          sendError(ws, 'signal requires "to" field');
          return;
        }
        const target = rooms.findInRoom(info.roomId, msg.to);
        if (!target) {
          sendError(ws, `Peer "${msg.to}" not found in room`);
          return;
        }
        send(target.ws, { type: 'signal', from: info.name, payload: msg.payload });
        break;
      }

      case 'position': {
        // Peer-presence metadata broadcast (name/champion/mute/dead state).
        // NOT the XY coordinates — those use 'coords' since v0.2.
        const info = rooms.getClientInfo(ws);
        if (!info) {
          sendError(ws, 'Not in a room');
          return;
        }
        const others = rooms.getOthersInRoom(ws);
        for (const peer of others) {
          send(peer.ws, { type: 'position', from: info.name, blob: msg.blob });
        }
        break;
      }

      case 'coords': {
        // v0.2 server-side proximity: client reports its XY directly to the
        // server (replaces the v0.1 encrypted-blob exchange over WebRTC data
        // channels). Server stores in room state; the next /compute-volumes
        // request reads it for pairwise distance.
        const info = rooms.getClientInfo(ws);
        if (!info) {
          sendError(ws, 'Not in a room');
          return;
        }
        if (typeof msg.x !== 'number' || typeof msg.y !== 'number' ||
            !isFinite(msg.x) || !isFinite(msg.y)) {
          sendError(ws, 'coords requires finite x and y');
          return;
        }
        rooms.setPosition(ws, msg.x, msg.y);
        break;
      }

      default:
        sendError(ws, `Unknown message type: ${(msg as any).type}`);
    }
  });

  ws.on('close', () => {
    const info = rooms.leave(ws);
    if (info) {
      eventLog.info(`${info.label ?? info.name} left room ${info.roomId}`, {
        clientId: info.clientId,
        roomId: info.roomId,
        name: info.name,
        label: info.label ?? undefined,
      });
      const peerNames = rooms.getPeers(info.roomId);
      for (const name of peerNames) {
        const peer = rooms.findInRoom(info.roomId, name);
        if (peer) {
          send(peer.ws, { type: 'peer_left', name: info.name });
        }
      }
    } else {
      const meta = rooms.getConnectionMeta(ws);
      const label = meta?.label;
      eventLog.info(label ? `${label} disconnected` : 'Client disconnected', {
        clientId,
        label: label ?? undefined,
      });
    }
  });
}
