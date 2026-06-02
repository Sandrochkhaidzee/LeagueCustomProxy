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
  it('returns ~1.0 at distance 0 (top bucket with ±5% jitter)', () => {
    const v = calculateVolume(0);
    expect(v).toBeGreaterThanOrEqual(0.95);
    expect(v).toBeLessThanOrEqual(1.0);
  });

  it('returns exactly 0.0 at distance >= 1200', () => {
    expect(calculateVolume(1200)).toBe(0.0);
    expect(calculateVolume(5000)).toBe(0.0);
  });

  it('is monotonically non-increasing in expectation across buckets', () => {
    // Average many samples to absorb the ±5% jitter, then check that
    // averaged volumes don't increase as distance grows. (Strict
    // monotonicity is no longer true tick-by-tick because adjacent
    // distances can fall in the same bucket or have jitter cross over.)
    const distances = [0, 100, 200, 400, 600, 800, 1000, 1100, 1200];
    const avgs = distances.map((d) => {
      let sum = 0;
      const N = 200;
      for (let i = 0; i < N; i++) sum += calculateVolume(d);
      return sum / N;
    });
    for (let i = 1; i < avgs.length; i++) {
      expect(avgs[i]).toBeLessThanOrEqual(avgs[i - 1] + 0.02);
    }
  });

  it('snaps to discrete buckets within jitter tolerance', () => {
    // Every returned value should sit within ±5% of one of the five
    // bucket centers: 0, 0.20, 0.45, 0.75, 1.0.
    const centers = [0, 0.20, 0.45, 0.75, 1.0];
    const tolerance = 0.05;
    for (const d of [0, 100, 300, 500, 700, 900, 1100]) {
      const v = calculateVolume(d);
      const matched = centers.some((c) => Math.abs(v - c) <= c * tolerance + 0.001);
      expect(matched, `volume ${v} (distance ${d}) not within tolerance of any bucket center`).toBe(true);
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
    // Same position => distance 0 => top bucket, ~1.0 within jitter
    expect(result.peerVolumes.PeerA).toBeGreaterThanOrEqual(0.95);
    expect(result.peerVolumes.PeerA).toBeLessThanOrEqual(1.0);
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
