import { describe, it, expect } from 'vitest';
import { generateTurnCredentials } from '../src/turn.js';

describe('generateTurnCredentials', () => {
  it('should return empty iceServers when server is empty', async () => {
    const result = await generateTurnCredentials('', 'some-secret');
    expect(result).toEqual({ iceServers: [] });
  });

  it('should return empty iceServers when secret is empty', async () => {
    const result = await generateTurnCredentials('turn.example.com', '');
    expect(result).toEqual({ iceServers: [] });
  });

  it('should return exactly 4 ICE servers for valid config', async () => {
    const result = await generateTurnCredentials('turn.example.com', 'test-secret');
    expect(result.iceServers).toHaveLength(4);
  });

  it('should have Google STUN as first server', async () => {
    const result = await generateTurnCredentials('turn.example.com', 'test-secret');
    expect(result.iceServers[0]).toEqual({ urls: 'stun:stun.l.google.com:19302' });
  });

  it('should have TURN server with username and credential as third entry', async () => {
    const result = await generateTurnCredentials('turn.example.com', 'test-secret');
    const turn = result.iceServers[2];
    expect(turn.urls).toBe('turn:turn.example.com:3478');
    expect(turn.username).toBeDefined();
    expect(turn.credential).toBeDefined();
    expect(typeof turn.username).toBe('string');
    expect(typeof turn.credential).toBe('string');
  });

  it('should have username containing future expiry (~24h from now)', async () => {
    const before = Math.floor(Date.now() / 1000) + 24 * 3600;
    const result = await generateTurnCredentials('turn.example.com', 'test-secret');
    const after = Math.floor(Date.now() / 1000) + 24 * 3600;

    const username = result.iceServers[2].username!;
    expect(username).toMatch(/^\d+:proxchat$/);

    const expiry = parseInt(username.split(':')[0]);
    expect(expiry).toBeGreaterThanOrEqual(before);
    expect(expiry).toBeLessThanOrEqual(after);
  });
});
