import {
  computeMaxJumpPx,
  computeReacquireThreshold,
  computeBlobScore,
  pickBestBlobInRange,
  pickClassifierReacquisition,
  CLS_FOLLOW_THRESHOLD,
} from '../../src/services/tracking-helpers';
import type { Blob } from '../../src/services/blob-types';

function mkBlob(cx: number, cy: number): Blob {
  return {
    color: 'teal',
    pixels: 100,
    cx, cy,
    minX: cx - 5, maxX: cx + 5,
    minY: cy - 5, maxY: cy + 5,
    fillRatio: 0.8,
  };
}

describe('computeMaxJumpPx', () => {
  test('returns 2x icon-diameter base when not in hold', () => {
    expect(computeMaxJumpPx(12, /*holdStartMs*/ 0, /*now*/ 1000)).toBe(24);
  });

  test('enforces minimum of 20 even for tiny icons', () => {
    expect(computeMaxJumpPx(5, 0, 1000)).toBe(20);
  });

  test('expands by ~1 icon-diameter per second of hold', () => {
    // hold for 2 seconds, icon = 12 → base 24 + (12 * 2) = 48
    expect(computeMaxJumpPx(12, /*hold start*/ 1000, /*now*/ 3000)).toBe(48);
  });

  test('zero hold equals no expansion', () => {
    expect(computeMaxJumpPx(12, 1000, 1000)).toBe(24);
  });
});

describe('computeReacquireThreshold', () => {
  test('default 0.5 when fresh + brief hold', () => {
    expect(computeReacquireThreshold(/*stationary*/ 0, /*hold*/ 0)).toBe(0.5);
  });

  test('relaxes to 0.35 after >1s of hold', () => {
    expect(computeReacquireThreshold(0, 2)).toBe(0.35);
  });

  test('tightens to 0.85 if stationary for >3s (likely render glitch, not teleport)', () => {
    expect(computeReacquireThreshold(5, 0)).toBe(0.85);
    // Stationary check wins even if hold has been short
    expect(computeReacquireThreshold(5, 2)).toBe(0.85);
  });
});

describe('computeBlobScore', () => {
  test('with classifier: pos + cls dominate, weights sum ~1.0', () => {
    const s = computeBlobScore({ posScore: 1, clsScore: 1, whiteScore: 1, peerScore: 1 }, true);
    expect(s).toBeCloseTo(1.0, 5);
  });

  test('without classifier: clsScore is ignored entirely', () => {
    // cls=0 (modified) and cls=1 should both produce the same score when no classifier
    const a = computeBlobScore({ posScore: 0.5, clsScore: 0, whiteScore: 0.5, peerScore: 0.5 }, false);
    const b = computeBlobScore({ posScore: 0.5, clsScore: 1, whiteScore: 0.5, peerScore: 0.5 }, false);
    expect(a).toBe(b);
  });

  test('higher posScore strictly wins (ceteris paribus)', () => {
    const lo = computeBlobScore({ posScore: 0.2, clsScore: 0.5, whiteScore: 0.5, peerScore: 0.5 }, true);
    const hi = computeBlobScore({ posScore: 0.8, clsScore: 0.5, whiteScore: 0.5, peerScore: 0.5 }, true);
    expect(hi).toBeGreaterThan(lo);
  });
});

describe('pickBestBlobInRange', () => {
  const noScores = {
    cls: () => 0.5,
    white: () => 0.5,
    peer: () => 0.5,
  };

  test('picks the blob closest to the predicted position', () => {
    const blobs = [mkBlob(100, 100), mkBlob(105, 100), mkBlob(150, 100)];
    const result = pickBestBlobInRange(
      blobs,
      /*lastReg*/ { x: 95, y: 100 },
      /*predicted*/ { x: 105, y: 100 },
      /*maxJumpPx*/ 60,
      /*hasClassifier*/ false,
      noScores,
    );
    expect(result?.blob.cx).toBe(105);
  });

  test('excludes blobs outside jump radius', () => {
    const blobs = [mkBlob(200, 100)]; // 100px away from lastReg
    const result = pickBestBlobInRange(
      blobs,
      { x: 100, y: 100 },
      { x: 100, y: 100 },
      30,
      false,
      noScores,
    );
    expect(result).toBeNull();
  });

  test('with classifier, drops blobs below CLS_FOLLOW_THRESHOLD even if positionally great', () => {
    const blob = mkBlob(100, 100);
    const lowClsFns = { ...noScores, cls: () => CLS_FOLLOW_THRESHOLD - 0.01 };
    const result = pickBestBlobInRange(
      [blob],
      { x: 100, y: 100 },
      { x: 100, y: 100 },
      30,
      true,
      lowClsFns,
    );
    expect(result).toBeNull();
  });

  test('without classifier, low cls scores do not exclude blobs', () => {
    const blob = mkBlob(100, 100);
    const lowClsFns = { ...noScores, cls: () => 0.0 };
    const result = pickBestBlobInRange(
      [blob],
      { x: 100, y: 100 },
      { x: 100, y: 100 },
      30,
      false,
      lowClsFns,
    );
    expect(result?.blob).toBe(blob);
  });

  test('empty input returns null', () => {
    expect(pickBestBlobInRange([], { x: 0, y: 0 }, { x: 0, y: 0 }, 30, false, noScores)).toBeNull();
  });
});

describe('pickClassifierReacquisition', () => {
  test('returns highest-confidence blob above threshold', () => {
    const blobs = [mkBlob(0, 0), mkBlob(50, 50), mkBlob(200, 200)];
    const scores = new Map<Blob, number>([
      [blobs[0], 0.4],   // below threshold (0.5)
      [blobs[1], 0.7],
      [blobs[2], 0.9],
    ]);
    const result = pickClassifierReacquisition(blobs, 0.5, (b) => scores.get(b) ?? 0);
    expect(result?.blob).toBe(blobs[2]);
    expect(result?.score).toBe(0.9);
  });

  test('returns null when no blob clears the threshold', () => {
    const blobs = [mkBlob(0, 0), mkBlob(50, 50)];
    const result = pickClassifierReacquisition(blobs, 0.8, () => 0.5);
    expect(result).toBeNull();
  });

  test('threshold of 0 returns highest-scoring blob (no exclusion)', () => {
    const blobs = [mkBlob(0, 0), mkBlob(50, 50)];
    const scores = new Map<Blob, number>([[blobs[0], 0.1], [blobs[1], 0.3]]);
    const result = pickClassifierReacquisition(blobs, 0, (b) => scores.get(b) ?? 0);
    expect(result?.blob).toBe(blobs[1]);
  });

  test('empty input returns null', () => {
    expect(pickClassifierReacquisition([], 0.5, () => 1.0)).toBeNull();
  });
});
