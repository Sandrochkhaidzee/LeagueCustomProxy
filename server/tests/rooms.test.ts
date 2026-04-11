import { describe, it, expect, beforeEach } from 'vitest';
import { RoomManager } from '../src/rooms.js';
import type { WebSocket } from 'ws';

// Minimal mock WebSocket — just needs to be a unique object reference
function mockWs(): WebSocket {
  return { readyState: 1 } as unknown as WebSocket;
}

describe('RoomManager', () => {
  let rooms: RoomManager;

  beforeEach(() => {
    rooms = new RoomManager();
  });

  it('should add a client to a room and return empty peers list for first joiner', () => {
    const ws = mockWs();
    const peers = rooms.join('room1', 'Alice', ws);
    expect(peers).toEqual([]);
    expect(rooms.getPeers('room1')).toEqual(['Alice']);
  });

  it('should return existing peers when a second client joins', () => {
    const ws1 = mockWs();
    const ws2 = mockWs();
    rooms.join('room1', 'Alice', ws1);
    const peers = rooms.join('room1', 'Bob', ws2);
    expect(peers).toEqual(['Alice']);
    expect(rooms.getPeers('room1')).toEqual(['Alice', 'Bob']);
  });

  it('should track multiple clients in the same room', () => {
    const ws1 = mockWs();
    const ws2 = mockWs();
    const ws3 = mockWs();
    rooms.join('room1', 'Alice', ws1);
    rooms.join('room1', 'Bob', ws2);
    rooms.join('room1', 'Charlie', ws3);
    expect(rooms.getPeers('room1')).toEqual(['Alice', 'Bob', 'Charlie']);
  });

  it('should remove a client on leave and return their info', () => {
    const ws1 = mockWs();
    const ws2 = mockWs();
    rooms.join('room1', 'Alice', ws1);
    rooms.join('room1', 'Bob', ws2);

    const info = rooms.leave(ws1);
    expect(info).toEqual({ roomId: 'room1', name: 'Alice' });
    expect(rooms.getPeers('room1')).toEqual(['Bob']);
  });

  it('should auto-delete room when last client leaves', () => {
    const ws = mockWs();
    rooms.join('room1', 'Alice', ws);
    expect(rooms.roomCount).toBe(1);

    rooms.leave(ws);
    expect(rooms.roomCount).toBe(0);
    expect(rooms.getPeers('room1')).toEqual([]);
  });

  it('should return undefined when leaving without having joined', () => {
    const ws = mockWs();
    const info = rooms.leave(ws);
    expect(info).toBeUndefined();
  });

  it('should exclude self from getOthersInRoom', () => {
    const ws1 = mockWs();
    const ws2 = mockWs();
    const ws3 = mockWs();
    rooms.join('room1', 'Alice', ws1);
    rooms.join('room1', 'Bob', ws2);
    rooms.join('room1', 'Charlie', ws3);

    const others = rooms.getOthersInRoom(ws2);
    expect(others).toHaveLength(2);
    expect(others.map(c => c.name)).toEqual(['Alice', 'Charlie']);
  });

  it('should find a client by room and name', () => {
    const ws = mockWs();
    rooms.join('room1', 'Alice', ws);

    const found = rooms.findInRoom('room1', 'Alice');
    expect(found).toBeDefined();
    expect(found!.ws).toBe(ws);
    expect(found!.name).toBe('Alice');
  });

  it('should return undefined for findInRoom with unknown name', () => {
    const ws = mockWs();
    rooms.join('room1', 'Alice', ws);

    expect(rooms.findInRoom('room1', 'Bob')).toBeUndefined();
    expect(rooms.findInRoom('room2', 'Alice')).toBeUndefined();
  });

  it('should return client info via getClientInfo', () => {
    const ws = mockWs();
    rooms.join('room1', 'Alice', ws);

    const info = rooms.getClientInfo(ws);
    expect(info).toEqual({ roomId: 'room1', name: 'Alice', ws });
  });

  it('should track rooms independently', () => {
    const ws1 = mockWs();
    const ws2 = mockWs();
    rooms.join('room1', 'Alice', ws1);
    rooms.join('room2', 'Bob', ws2);

    expect(rooms.roomCount).toBe(2);
    expect(rooms.getPeers('room1')).toEqual(['Alice']);
    expect(rooms.getPeers('room2')).toEqual(['Bob']);
  });
});
