import type { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import type { ClientInfo } from './types.js';
import type { TieredRoomClient } from './volumes.js';
import type { AdminClient, EventLog } from './admin.js';

interface ConnectionMeta {
  clientId: string;
  ip: string;
  connectedAt: number;
  label: string | null;
}

export class RoomManager {
  /** roomId → set of ClientInfo */
  private rooms = new Map<string, ClientInfo[]>();
  /** ws → ClientInfo (for fast lookup on disconnect) */
  private clients = new Map<WebSocket, ClientInfo>();
  /** ws → meta for connections not yet in a room */
  private pending = new Map<WebSocket, ConnectionMeta>();
  /** clientId → ws */
  private byClientId = new Map<string, WebSocket>();

  registerConnection(ws: WebSocket, ip: string): string {
    const clientId = randomUUID();
    const meta: ConnectionMeta = { clientId, ip, connectedAt: Date.now(), label: null };
    this.pending.set(ws, meta);
    this.byClientId.set(clientId, ws);
    return clientId;
  }

  /**
   * Add a client to a room. Returns list of existing peer names (before this join).
   */
  join(roomId: string, name: string, ws: WebSocket, team?: 'ORDER' | 'CHAOS'): string[] {
    const pendingMeta = this.pending.get(ws);
    const clientId = pendingMeta?.clientId ?? randomUUID();
    const connectedAt = pendingMeta?.connectedAt ?? Date.now();
    this.pending.delete(ws);
    this.byClientId.set(clientId, ws);

    const existing = this.rooms.get(roomId) ?? [];
    const existingNames = existing.map(c => c.name);

    const info: ClientInfo = {
      clientId,
      connectedAt,
      roomId,
      name,
      label: pendingMeta?.label ?? null,
      ws,
      team,
    };
    existing.push(info);
    this.rooms.set(roomId, existing);
    this.clients.set(ws, info);

    return existingNames;
  }

  /** Remove a client. Returns their info, or undefined if not found. */
  leave(ws: WebSocket): ClientInfo | undefined {
    const pending = this.pending.get(ws);
    if (pending) {
      this.pending.delete(ws);
      this.byClientId.delete(pending.clientId);
      return undefined;
    }

    const info = this.clients.get(ws);
    if (!info) return undefined;

    this.clients.delete(ws);
    this.byClientId.delete(info.clientId);

    const room = this.rooms.get(info.roomId);
    if (room) {
      const idx = room.indexOf(info);
      if (idx !== -1) room.splice(idx, 1);
      if (room.length === 0) {
        this.rooms.delete(info.roomId);
      }
    }

    return info;
  }

  kick(clientId: string, eventLog?: EventLog): boolean {
    const ws = this.byClientId.get(clientId);
    if (!ws) return false;

    const info = this.clients.get(ws);
    const display = info?.label ?? info?.name ?? clientId;
    if (eventLog) {
      eventLog.warn(`Kicked ${display}`, {
        clientId,
        roomId: info?.roomId,
        name: info?.name,
        label: info?.label ?? this.pending.get(ws)?.label ?? undefined,
      });
    }

    ws.close(1008, 'kicked by host');
    return true;
  }

  setLabel(ws: WebSocket, label: string): void {
    const pending = this.pending.get(ws);
    if (pending) {
      pending.label = label;
      return;
    }
    const info = this.clients.get(ws);
    if (info) info.label = label;
  }

  listClients(): AdminClient[] {
    const out: AdminClient[] = [];
    for (const info of this.clients.values()) {
      out.push({
        clientId: info.clientId,
        label: info.label,
        roomId: info.roomId,
        name: info.name,
        team: info.team ?? null,
        connectedAt: info.connectedAt,
      });
    }
    for (const meta of this.pending.values()) {
      out.push({
        clientId: meta.clientId,
        label: meta.label,
        roomId: null,
        name: null,
        team: null,
        connectedAt: meta.connectedAt,
      });
    }
    out.sort((a, b) => a.connectedAt - b.connectedAt);
    return out;
  }

  /** Get all peer names in a room. */
  getPeers(roomId: string): string[] {
    const room = this.rooms.get(roomId);
    return room ? room.map(c => c.name) : [];
  }

  /** Get all other clients in the same room (excludes the given ws). */
  getOthersInRoom(ws: WebSocket): ClientInfo[] {
    const info = this.clients.get(ws);
    if (!info) return [];
    const room = this.rooms.get(info.roomId);
    if (!room) return [];
    return room.filter(c => c.ws !== ws);
  }

  /** Find a specific client in a room by name. */
  findInRoom(roomId: string, name: string): ClientInfo | undefined {
    const room = this.rooms.get(roomId);
    if (!room) return undefined;
    return room.find(c => c.name === name);
  }

  /** Get client info for a WebSocket. */
  getClientInfo(ws: WebSocket): ClientInfo | undefined {
    return this.clients.get(ws);
  }

  getConnectionMeta(ws: WebSocket): ConnectionMeta | undefined {
    return this.pending.get(ws);
  }

  /**
   * Record a client's latest XY position. No-op if the ws isn't in a room.
   */
  setPosition(ws: WebSocket, x: number, y: number): void {
    const info = this.clients.get(ws);
    if (!info) return;
    info.position = { x, y, updatedMs: Date.now() };
  }

  /**
   * Snapshot of all peer positions in a room, keyed by name.
   */
  getRoomPositions(
    roomId: string,
    exceptName: string,
    staleMs: number,
  ): Record<string, { x: number; y: number }> {
    const room = this.rooms.get(roomId);
    if (!room) return {};
    const cutoff = Date.now() - staleMs;
    const out: Record<string, { x: number; y: number }> = {};
    for (const c of room) {
      if (c.name === exceptName) continue;
      if (!c.position) continue;
      if (c.position.updatedMs < cutoff) continue;
      out[c.name] = { x: c.position.x, y: c.position.y };
    }
    return out;
  }

  getRoomClients(roomId: string): TieredRoomClient[] {
    const room = this.rooms.get(roomId);
    if (!room) return [];
    return room.map(c => ({
      name: c.name,
      team: c.team,
      position: c.position,
    }));
  }

  /** Number of active rooms. */
  get roomCount(): number {
    return this.rooms.size;
  }
}
