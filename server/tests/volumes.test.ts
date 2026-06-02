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
  it('returns exactly 1.0 at distance 0', () => {
    expect(calculateVolume(0)).toBe(1.0);
  });

  it('returns exactly 0.0 at distance >= MAX_HEARING_RANGE', () => {
    expect(calculateVolume(1200)).toBe(0.0);
    expect(calculateVolume(5000)).toBe(0.0);
  });

  it('is strictly monotonically decreasing across the audible range', () => {
    const distances = [0, 100, 200, 400, 600, 800, 1000, 1100, 1199];
    const volumes = distances.map(calculateVolume);
    for (let i = 1; i < volumes.length; i++) {
      expect(volumes[i]).toBeLessThan(volumes[i - 1]);
    }
  });

  it('follows the documented 1 - (d/MAX)² quadratic falloff', () => {
    // At half the hearing range: 1 - 0.5² = 0.75
    expect(calculateVolume(600)).toBeCloseTo(0.75, 5);
    // At 3/4 range: 1 - 0.75² = 0.4375
    expect(calculateVolume(900)).toBeCloseTo(0.4375, 5);
  });

  it('is deterministic — same input gives same output', () => {
    // After reverting the v0.1.26 quantization+jitter (v0.1.33), the
    // function is pure: no Math.random() in the path.
    const a = calculateVolume(500);
    const b = calculateVolume(500);
    expect(a).toBe(b);
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
    // Same position => distance 0 => exactly 1.0 (continuous since v0.1.33).
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
