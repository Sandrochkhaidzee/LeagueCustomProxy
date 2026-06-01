import { describe, it, expect } from 'vitest';
import {
  calculateVolume,
  encryptPosition,
  decryptPosition,
  computeVolumes,
} from '../src/volumes.js';

// 64 hex chars = 256-bit test key
const TEST_KEY = 'a'.repeat(64);

describe('calculateVolume', () => {
  it('returns 1.0 at distance 0', () => {
    expect(calculateVolume(0)).toBe(1.0);
  });

  it('returns 0.0 at distance >= 1300', () => {
    expect(calculateVolume(1300)).toBe(0.0);
    expect(calculateVolume(5000)).toBe(0.0);
  });

  it('is monotonically decreasing', () => {
    const distances = [0, 100, 200, 400, 600, 800, 1000, 1200, 1300];
    const volumes = distances.map(calculateVolume);
    for (let i = 1; i < volumes.length; i++) {
      expect(volumes[i]).toBeLessThanOrEqual(volumes[i - 1]);
    }
  });
});

describe('encryptPosition / decryptPosition', () => {
  it('roundtrip preserves position', async () => {
    const blob = await encryptPosition(TEST_KEY, 123.5, -456.7);
    const result = await decryptPosition(TEST_KEY, blob);
    expect(result).not.toBeNull();
    expect(result!.x).toBeCloseTo(123.5);
    expect(result!.y).toBeCloseTo(-456.7);
  });

  it('rejects tampered blobs (returns null)', async () => {
    const blob = await encryptPosition(TEST_KEY, 10, 20);
    // Flip a character in the middle of the blob
    const tampered = blob.slice(0, 20) + 'Z' + blob.slice(21);
    const result = await decryptPosition(TEST_KEY, tampered);
    expect(result).toBeNull();
  });
});

describe('computeVolumes', () => {
  it('returns myBlob and peerVolumes for valid input', async () => {
    // First encrypt a peer position
    const peerBlob = await encryptPosition(TEST_KEY, 100, 100);

    const result = await computeVolumes(
      {
        myPosition: { x: 100, y: 100 },
        peers: { PeerA: peerBlob },
      },
      TEST_KEY,
    );

    expect(result.myBlob).toBeTruthy();
    expect(typeof result.myBlob).toBe('string');
    expect(result.peerVolumes).toBeDefined();
    expect(typeof result.peerVolumes.PeerA).toBe('number');
    // Same position => distance 0 => volume 1.0
    expect(result.peerVolumes.PeerA).toBe(1.0);
  });

  it('returns volume 0 for invalid peer blobs', async () => {
    const result = await computeVolumes(
      {
        myPosition: { x: 0, y: 0 },
        peers: { BadPeer: 'not-a-valid-blob' },
      },
      TEST_KEY,
    );

    expect(result.peerVolumes.BadPeer).toBe(0);
  });
});
