import type { WebSocket } from 'ws';
import type { ClientInfo } from './types.js';

export class RoomManager {
  /** roomId → set of ClientInfo */
  private rooms = new Map<string, ClientInfo[]>();
  /** ws → ClientInfo (for fast lookup on disconnect) */
  private clients = new Map<WebSocket, ClientInfo>();

  /** Add a client to a room. Returns list of existing peer names (before this join). */
  join(roomId: string, name: string, ws: WebSocket): string[] {
    const existing = this.rooms.get(roomId) ?? [];
    const existingNames = existing.map(c => c.name);

    const info: ClientInfo = { roomId, name, ws };
    existing.push(info);
    this.rooms.set(roomId, existing);
    this.clients.set(ws, info);

    return existingNames;
  }

  /** Remove a client. Returns their info, or undefined if not found. */
  leave(ws: WebSocket): { roomId: string; name: string } | undefined {
    const info = this.clients.get(ws);
    if (!info) return undefined;

    this.clients.delete(ws);

    const room = this.rooms.get(info.roomId);
    if (room) {
      const idx = room.indexOf(info);
      if (idx !== -1) room.splice(idx, 1);
      if (room.length === 0) {
        this.rooms.delete(info.roomId);
      }
    }

    return { roomId: info.roomId, name: info.name };
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

  /** Number of active rooms. */
  get roomCount(): number {
    return this.rooms.size;
  }
}
