// Pure helpers extracted from TrackingService.handleLocked. Each is a
// stateless function with deterministic output for a given input — easy to
// unit-test in isolation. State mutation and side effects (callback firing,
// logging, position updates) stay in TrackingService itself.

import type { Blob } from './blob-types';

/**
 * Maximum allowed per-frame jump distance, in minimap pixels. Allows normal
 * frame-to-frame movement plus a growing search radius while holding position
 * so we can re-acquire a blob that moved during the hold.
 */
export function computeMaxJumpPx(
  expectedIconDiam: number,
  holdStartMs: number,
  nowMs: number,
): number {
  const base = Math.max(20, Math.round(expectedIconDiam * 2.0));
  const holdSec = holdStartMs > 0 ? (nowMs - holdStartMs) / 1000 : 0;
  const holdExpansion = holdSec > 0
    ? Math.min(Math.round(expectedIconDiam * 1.5), Math.round(expectedIconDiam * holdSec))
    : 0;
  return base + holdExpansion;
}

/**
 * Classifier confidence threshold for Phase-2 long-distance re-acquisition.
 * After standing still for a while, raise the bar dramatically — a lost icon
 * is more likely a render glitch than a teleport, and we don't want to lock
 * onto a minion wave. After a brief hold (>1s), lower the threshold for
 * faster recovery from genuine teleports.
 */
export function computeReacquireThreshold(
  stationarySec: number,
  holdSec: number,
): number {
  if (stationarySec > 3) return 0.85;
  if (holdSec > 1.0) return 0.35;
  return 0.5;
}

export interface BlobScoreInputs {
  /** 1 = on the predicted point, decays toward 0 at max-jump edge. */
  posScore: number;
  /** 0..1 classifier confidence for this blob being the local champion. */
  clsScore: number;
  /** 0..1 heuristic on how many "white" (champion-mark) pixels surround the blob. */
  whiteScore: number;
  /** 0..1, lower if the blob is suspiciously close to a known ally peer. */
  peerScore: number;
}

/**
 * Composite score for a candidate blob. When the classifier is loaded we
 * weight its confidence heavily; without it, position dominates.
 */
export function computeBlobScore(s: BlobScoreInputs, hasClassifier: boolean): number {
  return hasClassifier
    ? s.posScore * 0.35 + s.clsScore * 0.30 + s.whiteScore * 0.20 + s.peerScore * 0.15
    : s.posScore * 0.45 + s.peerScore * 0.30 + s.whiteScore * 0.25;
}

/** Minimum classifier confidence to follow a blob during Phase 1 tracking. */
export const CLS_FOLLOW_THRESHOLD = 0.2;

export interface ScoreFns {
  cls: (b: Blob) => number;
  white: (b: Blob) => number;
  peer: (b: Blob) => number;
}

export interface ScoredBlob {
  blob: Blob;
  score: number;
}

/**
 * Phase 1: pick the best teal blob within jump range of the predicted
 * position. Returns null if no candidate scored above the (classifier-gated)
 * follow threshold.
 */
export function pickBestBlobInRange(
  tealBlobs: Blob[],
  lastReg: { x: number; y: number },
  predicted: { x: number; y: number },
  maxJumpPx: number,
  hasClassifier: boolean,
  scoreFns: ScoreFns,
): ScoredBlob | null {
  const maxJumpSq = maxJumpPx * maxJumpPx;
  let best: ScoredBlob | null = null;

  for (const b of tealBlobs) {
    const dxLast = b.cx - lastReg.x;
    const dyLast = b.cy - lastReg.y;
    if (dxLast * dxLast + dyLast * dyLast > maxJumpSq) continue;

    const dxPred = b.cx - predicted.x;
    const dyPred = b.cy - predicted.y;
    const posScore = 1 - (dxPred * dxPred + dyPred * dyPred) / maxJumpSq;

    const clsScore = scoreFns.cls(b);
    if (hasClassifier && clsScore < CLS_FOLLOW_THRESHOLD) continue;

    const score = computeBlobScore(
      { posScore, clsScore, whiteScore: scoreFns.white(b), peerScore: scoreFns.peer(b) },
      hasClassifier,
    );
    if (!best || score > best.score) best = { blob: b, score };
  }
  return best;
}

/**
 * Minimum *absolute* template-match confidence (raw SSIM-margin remapped to
 * [0,1]) required to lock or re-acquire onto a blob anywhere on the minimap.
 *
 * Both re-acquisition (Phase 2) and the SCANNING→LOCK transition pick the
 * best-scoring blob regardless of distance, scored on the *normalized* (best
 * blob = 1.0) confidence. Normalization is relative, so it can't tell "the real
 * champion" from "the least-bad of a frame full of wrong blobs" — letting a
 * minion/ally icon win and yanking the broadcast position across the map
 * (observed: position teleporting between opposite corners). The *raw* template
 * score is absolute, so we gate on it. Real-game measurement: the true
 * champion's blob scores 0.56-0.65 here; wrong blobs (minions, ally icons) top
 * out at ~0.49. 0.53 sits in that gap. Below it, the tracker holds/extrapolates
 * (or stays SCANNING) rather than chasing a wrong blob.
 *
 * Only applied on the template path. The old 172-class classifier had no
 * meaningful absolute confidence (weak on champions like Teemo), which is why
 * v0.3.1 reverted a similar gate — it refused to lock at all. Template matching
 * is reliable, so the gate fails safe to "no lock," never "wrong lock."
 */
export const REACQUIRE_TEMPLATE_MIN = 0.53;

/**
 * Phase 2: pick the teal blob with the highest classifier confidence above
 * the (adaptive) reacquire threshold, regardless of distance. Handles
 * teleport, respawn, camera pan, blob-overlap recovery.
 *
 * `absGate` (optional) adds an absolute-confidence floor on top of the relative
 * `threshold` — a blob must clear BOTH to be eligible. Used on the template
 * path to reject far wrong-blob jumps; omitted on the classifier fallback.
 */
export function pickClassifierReacquisition(
  tealBlobs: Blob[],
  threshold: number,
  clsScoreFn: (b: Blob) => number,
  absGate?: { scoreFn: (b: Blob) => number; min: number },
): ScoredBlob | null {
  let best: ScoredBlob | null = null;
  for (const b of tealBlobs) {
    const clsScore = clsScoreFn(b);
    if (clsScore < threshold) continue;
    if (absGate && absGate.scoreFn(b) < absGate.min) continue;
    if (!best || clsScore > best.score) best = { blob: b, score: clsScore };
  }
  return best;
}

// ---------- v0.3 tracking tweaks (driven by IXAM's v0.1.33 issue #7 logs) ----------

/**
 * After this many ms of continuous hold, extrapolated position is essentially
 * noise — the player could be anywhere. Force a drop back to SCANNING-style
 * classifier-driven full-minimap search rather than continuing to extend the
 * search box. IXAM's v0.1.33 logs showed 44-second holds during which the
 * orchestrator was sending phantom coords; 5s is the budget for "tracking
 * should have recovered by now or it's time to start over."
 */
export const FORCED_REACQUIRE_HOLD_MS = 5000;

export function shouldForceReacquisition(holdStartMs: number, nowMs: number): boolean {
  if (holdStartMs === 0) return false;
  return (nowMs - holdStartMs) >= FORCED_REACQUIRE_HOLD_MS;
}

/**
 * Standard exponential moving average for classifier confidence. `decay` is
 * the weight kept on the current value; `1 - decay` is the weight of the new
 * raw sample.
 *
 * v0.3.0 added a "snap up to raw on any increase" branch to recover from a
 * stuck-at-0 EMA (IXAM v0.1.33). That root cause was actually the Nunu/Dr.
 * Mundo label-mismatch bug (fixed in v0.2.1 — the classifier was returning 0
 * for every blob), NOT the EMA. The snap-up's real-world effect was harmful:
 * a single false-high raw on a wrong blob (a minion, a structure) latched the
 * EMA to 1.0, making the tracker confidently follow it — the "clinging to
 * minions and structures" failure. Reverted to symmetric EMA in v0.3.1; the
 * whole classifier-confidence path is replaced by template matching in v0.4
 * (see docs/plans/2026-06-03-cv-tracking-research.md).
 */
export function nextClassifierEma(currentEma: number, raw: number, decay: number): number {
  return currentEma * decay + raw * (1 - decay);
}

// ---------- v0.4 ring-annulus detection (champion shape signature) ----------

export interface AnnulusFeatures { ringTeal: number; centerTeal: number; score: number; }

/**
 * Champion-ring signature on the teal mask, measured around a blob center.
 * A champion icon is an ally-teal RING with a non-teal portrait CENTER; a turret
 * is teal-FILLED (high center); minions/terrain have little teal in the ring.
 * Bands are relative to the icon radius r: center < 0.55r, ring 0.70r–1.05r.
 * The 0.55r–0.70r gap is an intentional deadband — it skips the fuzzy
 * portrait/ring boundary so neither band is polluted by transition pixels,
 * sharpening the center-vs-ring contrast.
 * Validated on real crops (scripts/annulus_separation.py): champion score >0,
 * turret score <0. `mask[i]===1` means teal/ally. r/cx/cy may be fractional
 * (blob radius is max(bw,bh)/2, often ending in .5) — bands are computed in
 * squared-distance space so fractional inputs work without rounding.
 */
export function annulusFeatures(
  mask: Uint8Array, w: number, h: number, cx: number, cy: number, r: number,
): AnnulusFeatures {
  const cR = 0.55 * r, inner = 0.70 * r, outer = 1.05 * r;
  const cR2 = cR * cR, in2 = inner * inner, out2 = outer * outer;
  const x0 = Math.max(0, Math.floor(cx - outer)), x1 = Math.min(w - 1, Math.ceil(cx + outer));
  const y0 = Math.max(0, Math.floor(cy - outer)), y1 = Math.min(h - 1, Math.ceil(cy + outer));
  let cT = 0, cN = 0, rT = 0, rN = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d2 = (x - cx) * (x - cx) + (y - cy) * (y - cy);
      const teal = mask[y * w + x] === 1 ? 1 : 0;
      if (d2 <= cR2) { cN++; cT += teal; }
      else if (d2 >= in2 && d2 <= out2) { rN++; rT += teal; }
    }
  }
  const ringTeal = rN ? rT / rN : 0;
  const centerTeal = cN ? cT / cN : 0;
  return { ringTeal, centerTeal, score: ringTeal - centerTeal };
}

export interface RingMatch { cx: number; cy: number; ringTeal: number; centerTeal: number; score: number; }

/**
 * Best champion-ring match WITHIN a blob: scan candidate centers across the blob's
 * bbox at the EXPECTED icon radius (not the blob's own radius) and return the
 * highest-scoring annulus. Recovers a champion ring from a blob that merged with
 * an adjacent icon/turret — the merged centroid+radius score "filled" (negative),
 * but an icon-radius window centered on the actual ring still scores positive. For
 * a clean single-icon blob the best center ≈ the centroid. Offline-validated:
 * ~3.5x more frames with a detectable champion ring vs centroid-only.
 */
export function bestRingInBlob(
  mask: Uint8Array, w: number, h: number, blob: Blob, iconR: number,
): RingMatch {
  const step = Math.max(2, Math.round(iconR / 3));
  let best: RingMatch = { cx: blob.cx, cy: blob.cy, ringTeal: 0, centerTeal: 0, score: -Infinity };
  for (let cy = blob.minY; cy <= blob.maxY; cy += step) {
    for (let cx = blob.minX; cx <= blob.maxX; cx += step) {
      const a = annulusFeatures(mask, w, h, cx, cy, iconR);
      if (a.score > best.score) best = { cx, cy, ringTeal: a.ringTeal, centerTeal: a.centerTeal, score: a.score };
    }
  }
  return best;
}

/** Min ally-teal fraction in the ring band to consider a blob a champion ring.
 *  Provisional (Garen 90%/93% point); re-tuned in Phase 5 on more harvested data. */
export const RING_TEAL_MIN = 0.10;
/** Min annulus score (ringTeal − centerTeal) to accept; rejects teal-filled turrets. Provisional. */
export const ANNULUS_MIN = 0.05;

/** Follow-path anti-clutter floor (LENIENT): once locked, accept any teal blob
 *  near the predicted spot whose annulus isn't clearly a filled turret / minion
 *  clump. Much looser than the acquire gate (RING_TEAL_MIN/ANNULUS_MIN) — partial
 *  or neighbor-merged champion rings (score ~0) still pass; only strongly-negative
 *  (teal-FILLED) blobs are rejected, so we don't latch a turret when the champion
 *  has actually left (recall/teleport/death). */
export const FOLLOW_ANNULUS_FLOOR = -0.15;
/** Consecutive frames of trailing a sub-acquire-confidence (score < ANNULUS_MIN)
 *  blob before dropping the lock and forcing a strict reacquire — bounds how long
 *  we coast on a possibly-wrong blob when the champion has left. */
export const WEAK_FOLLOW_DROP = 15;
