import {
  computeMaxJumpPx,
  computeReacquireThreshold,
  computeBlobScore,
  pickBestBlobInRange,
  pickClassifierReacquisition,
  REACQUIRE_TEMPLATE_MIN,
  CLS_FOLLOW_THRESHOLD,
  shouldForceReacquisition,
  FORCED_REACQUIRE_HOLD_MS,
  nextClassifierEma,
  annulusFeatures,
  bestRingInBlob,
  ringCoverage,
  RING_TEAL_MIN,
  RING_COVERAGE_MIN,
  ANNULUS_MIN,
  FOLLOW_ANNULUS_FLOOR,
  WEAK_FOLLOW_DROP,
} from '../../src/services/tracking-helpers';
import type { Blob } from '../../src/services/blob-types';

// Build a w×h Uint8Array; set teal(=1) where pred(x,y) is true.
function mkMask(w: number, h: number, pred: (x: number, y: number) => boolean): Uint8Array {
  const m = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (pred(x, y)) m[y * w + x] = 1;
  return m;
}

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
    // hold for 2 seconds, icon = 12 → base 24 + min(12*1.5, 12*2) = 24 + 18 = 42
    expect(computeMaxJumpPx(12, /*hold start*/ 1000, /*now*/ 3000)).toBe(42);
  });

  test('caps hold expansion at 1.5 icon-diameters', () => {
    // hold for 5 seconds, icon = 12 → base 24 + min(12*1.5, 12*5) = 24 + 18 = 42
    expect(computeMaxJumpPx(12, /*hold start*/ 1000, /*now*/ 6000)).toBe(42);
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

  // v0.4.4: absolute-confidence gate stops far wrong-blob jumps. The relative
  // score still ranks; the abs gate vetoes blobs that aren't really the champion.
  test('absGate vetoes a relatively-best blob whose absolute confidence is too low', () => {
    const blobs = [mkBlob(0, 0), mkBlob(200, 200)];
    // blobs[1] wins the relative score but is a wrong blob (low abs confidence).
    const rel = new Map<Blob, number>([[blobs[0], 0.6], [blobs[1], 1.0]]);
    const abs = new Map<Blob, number>([[blobs[0], 0.6], [blobs[1], 0.45]]);
    const result = pickClassifierReacquisition(
      blobs, 0.5, (b) => rel.get(b) ?? 0,
      { scoreFn: (b) => abs.get(b) ?? 0, min: REACQUIRE_TEMPLATE_MIN },
    );
    expect(result?.blob).toBe(blobs[0]); // falls back to the real champion
  });

  test('absGate returns null when no blob clears the absolute floor', () => {
    const blobs = [mkBlob(0, 0), mkBlob(50, 50)];
    const abs = new Map<Blob, number>([[blobs[0], 0.4], [blobs[1], 0.49]]);
    const result = pickClassifierReacquisition(
      blobs, 0, () => 1.0,
      { scoreFn: (b) => abs.get(b) ?? 0, min: REACQUIRE_TEMPLATE_MIN },
    );
    expect(result).toBeNull(); // hold/extrapolate rather than chase a wrong blob
  });

  test('absGate admits a blob that clears both relative and absolute bars', () => {
    const blobs = [mkBlob(120, 120)];
    const result = pickClassifierReacquisition(
      blobs, 0.3, () => 0.9,
      { scoreFn: () => 0.6, min: REACQUIRE_TEMPLATE_MIN },
    );
    expect(result?.blob).toBe(blobs[0]);
  });

  test('REACQUIRE_TEMPLATE_MIN sits between measured wrong (≤0.49) and real (≥0.56) blob scores', () => {
    expect(REACQUIRE_TEMPLATE_MIN).toBeGreaterThan(0.49);
    expect(REACQUIRE_TEMPLATE_MIN).toBeLessThan(0.56);
  });
});

// ---------- v0.3 tracking tweaks (issue #7 root-cause fixes) ----------

describe('shouldForceReacquisition', () => {
  test('returns false when no hold is active (holdStartMs === 0)', () => {
    expect(shouldForceReacquisition(0, 1_000_000)).toBe(false);
  });
  test('returns false for hold below the threshold', () => {
    expect(shouldForceReacquisition(1000, 1000 + FORCED_REACQUIRE_HOLD_MS - 1)).toBe(false);
  });
  test('returns true at exactly the threshold', () => {
    expect(shouldForceReacquisition(1000, 1000 + FORCED_REACQUIRE_HOLD_MS)).toBe(true);
  });
  test('returns true for hold far past threshold (44-second IXAM-log case)', () => {
    expect(shouldForceReacquisition(1000, 1000 + 44_000)).toBe(true);
  });
});

describe('nextClassifierEma (symmetric EMA — v0.3.0 snap-up reverted in v0.3.1)', () => {
  test('decays toward 0 on a 0 sample', () => {
    // 0.5 * 0.7 + 0 * 0.3 = 0.35
    expect(nextClassifierEma(0.5, 0, 0.7)).toBeCloseTo(0.35, 5);
  });
  test('rises gradually toward a higher raw — does NOT snap (anti-clinging)', () => {
    // A single false-high raw must not latch the EMA to 1.0 (the v0.3.0
    // snap-up bug that made the tracker cling to minions/structures).
    // 0 * 0.7 + 0.8 * 0.3 = 0.24, not 0.8.
    expect(nextClassifierEma(0, 0.8, 0.7)).toBeCloseTo(0.24, 5);
  });
  test('standard EMA when raw is below current', () => {
    // 0.6 * 0.7 + 0.4 * 0.3 = 0.42 + 0.12 = 0.54
    expect(nextClassifierEma(0.6, 0.4, 0.7)).toBeCloseTo(0.54, 5);
  });
  test('a sustained high raw still climbs over a few frames', () => {
    let ema = 0;
    for (let i = 0; i < 5; i++) ema = nextClassifierEma(ema, 0.9, 0.7);
    expect(ema).toBeGreaterThan(0.6); // recovers without single-frame latching
  });
});

// ---------- v0.4 ring-annulus detection (champion shape signature) ----------

describe('annulusFeatures', () => {
  const W = 40, H = 40, cx = 20, cy = 20, r = 12;
  const ringOf = (x: number, y: number) => {
    const d = Math.hypot(x - cx, y - cy); return d >= 0.78 * r && d <= 1.0 * r; // a thin ring at the edge
  };
  const discOf = (x: number, y: number) => Math.hypot(x - cx, y - cy) <= r; // filled

  test('a teal RING scores strongly positive (champion)', () => {
    const f = annulusFeatures(mkMask(W, H, ringOf), W, H, cx, cy, r);
    expect(f.ringTeal).toBeGreaterThan(0.5);
    expect(f.centerTeal).toBeLessThan(0.1);
    expect(f.score).toBeGreaterThan(0.4);
  });

  test('a teal FILLED disc scores negative (turret)', () => {
    const f = annulusFeatures(mkMask(W, H, discOf), W, H, cx, cy, r);
    expect(f.centerTeal).toBeGreaterThan(0.8);
    expect(f.score).toBeLessThan(0); // center >> ring
  });

  test('empty mask scores ~0', () => {
    const f = annulusFeatures(mkMask(W, H, () => false), W, H, cx, cy, r);
    expect(f.ringTeal).toBe(0);
    expect(f.score).toBe(0);
  });

  // Phase 2 derives r from a blob's bounding box: max(bw,bh)/2 frequently ends
  // in .5 (e.g. a 23px box → r=11.5), and the blob center can be fractional too.
  // Lock in the float-radius contract: a teal ring around a fractional center
  // must still score clearly positive.
  test('fractional radius + center: teal ring still scores strongly positive', () => {
    const fcx = 20.5, fcy = 20.5, fr = 11.5;
    const ringOfFrac = (x: number, y: number) => {
      const d = Math.hypot(x - fcx, y - fcy);
      return d >= 0.78 * fr && d <= 1.0 * fr;
    };
    const f = annulusFeatures(mkMask(W, H, ringOfFrac), W, H, fcx, fcy, fr);
    expect(f.score).toBeGreaterThan(0.3);
  });
});

describe('bestRingInBlob', () => {
  const W = 56, H = 44, iconR = 12;

  // Blob whose bbox spans x:8..40, y:8..32 → centroid ~(24,20), but the teal RING
  // is centered OFF that centroid at (28,20). The centroid sits inside the ring's
  // hollow, so a centroid-only annulus would miss; scanning the bbox must land the
  // best center on the actual ring (the merged-blob recovery case).
  const ringCx = 28, ringCy = 20;
  const ringOf = (x: number, y: number) => {
    const d = Math.hypot(x - ringCx, y - ringCy);
    return d >= 0.78 * iconR && d <= 1.0 * iconR; // thin teal ring at icon-radius edge
  };
  const offsetBlob: Blob = {
    color: 'teal', pixels: 200, fillRatio: 0.3,
    cx: 24, cy: 20, minX: 8, maxX: 40, minY: 8, maxY: 32,
  };

  test('finds the champion ring centered off the blob centroid', () => {
    const m = mkMask(W, H, ringOf);
    const r = bestRingInBlob(m, W, H, offsetBlob, iconR);
    const step = Math.max(2, Math.round(iconR / 3)); // 4
    expect(Math.abs(r.cx - ringCx)).toBeLessThanOrEqual(step);
    expect(Math.abs(r.cy - ringCy)).toBeLessThanOrEqual(step);
    expect(r.score).toBeGreaterThan(0.4);
    expect(r.coverage).toBeGreaterThan(0.9); // a continuous ring covers ~all sectors
  });

  test('a fully teal-FILLED blob yields no champion ring (best score <= 0)', () => {
    // Turret core: a solid teal disc that fully encloses every candidate window in
    // the blob's bbox. Every center band AND ring band is 100% teal, so ringTeal -
    // centerTeal = 0 for all candidates — the scan can never fabricate a positive
    // ring out of filled teal. Best score is exactly 0, far below the acquire gate
    // (ANNULUS_MIN), so a filled turret is correctly rejected as "not a champion".
    const disc = (x: number, y: number) => Math.hypot(x - offsetBlob.cx, y - offsetBlob.cy) <= 30;
    const r = bestRingInBlob(mkMask(W, H, disc), W, H, offsetBlob, iconR);
    expect(r.score).toBeLessThanOrEqual(0);
    expect(r.score).toBeLessThan(ANNULUS_MIN);
  });
});

describe('ringCoverage', () => {
  const W = 40, H = 40, cx = 20, cy = 20, r = 12;
  test('a continuous teal ring covers ~all sectors (>= 0.9)', () => {
    const ring = (x: number, y: number) => {
      const d = Math.hypot(x - cx, y - cy); return d >= 0.78 * r && d <= 1.0 * r;
    };
    expect(ringCoverage(mkMask(W, H, ring), W, H, cx, cy, r)).toBeGreaterThan(0.9);
  });

  test('teal in only one wedge (a minion clump) covers few sectors (< RING_COVERAGE_MIN)', () => {
    // Teal only in a narrow wedge around +x — like a couple of clustered minion
    // dots: same ring-band presence locally, but it spans only 1-2 of 12 sectors.
    const wedge = (x: number, y: number) => {
      const dx = x - cx, dy = y - cy, d = Math.hypot(dx, dy);
      return d >= 0.78 * r && d <= 1.0 * r && dx > Math.abs(dy) * 2;
    };
    expect(ringCoverage(mkMask(W, H, wedge), W, H, cx, cy, r)).toBeLessThan(RING_COVERAGE_MIN);
  });

  test('empty mask covers nothing (0)', () => {
    expect(ringCoverage(mkMask(W, H, () => false), W, H, cx, cy, r)).toBe(0);
  });
});

describe('ring-annulus thresholds', () => {
  test('RING_TEAL_MIN is a tight fraction in (0, 0.5)', () => {
    expect(RING_TEAL_MIN).toBeGreaterThan(0);
    expect(RING_TEAL_MIN).toBeLessThan(0.5);
  });
  test('ANNULUS_MIN is a tight margin in (0, 0.3)', () => {
    expect(ANNULUS_MIN).toBeGreaterThan(0);
    expect(ANNULUS_MIN).toBeLessThan(0.3);
  });

  // Follow-path leniency knobs: under scan-max getRing, a filled turret scores ~0
  // so the floor requires a small POSITIVE ring score (rejects filled clutter,
  // champion rings score +0.14+), staying lenient vs the acquire gate by dropping
  // the RING_TEAL_MIN requirement. The coasting bound is a positive integer.
  test('FOLLOW_ANNULUS_FLOOR is a small non-negative below the acquire gate (scan-max regime)', () => {
    expect(FOLLOW_ANNULUS_FLOOR).toBeGreaterThanOrEqual(0);
    expect(FOLLOW_ANNULUS_FLOOR).toBeLessThan(0.05);
  });
  test('WEAK_FOLLOW_DROP is a positive integer', () => {
    expect(WEAK_FOLLOW_DROP).toBeGreaterThan(0);
    expect(Number.isInteger(WEAK_FOLLOW_DROP)).toBe(true);
  });
});
