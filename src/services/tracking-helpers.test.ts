import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeMaxJumpPx,
  nextClassifierEma,
  computeBlobScore,
  pickBestBlobInRange,
  type ScoreFns,
} from './tracking-helpers.ts';
import type { Blob } from './blob-types.ts';

const blob = (cx: number, cy: number): Blob => ({
  cx, cy, minX: cx - 5, minY: cy - 5, maxX: cx + 5, maxY: cy + 5,
  pixels: 100, fillRatio: 0.5, color: 'teal',
});

describe('computeMaxJumpPx', () => {
  it('grows with hold time', () => {
    const base = computeMaxJumpPx(20, 0, 1000);
    const held = computeMaxJumpPx(20, 500, 2500);
    assert.ok(held > base);
  });
});

describe('nextClassifierEma', () => {
  it('smooths toward new value', () => {
    const v = nextClassifierEma(0.8, 0.2, 0.6);
    assert.ok(v > 0.2 && v < 0.8);
  });
});

describe('computeBlobScore', () => {
  it('weights classifier when loaded', () => {
    const high = computeBlobScore({
      posScore: 0.5, clsScore: 1, whiteScore: 0, peerScore: 0,
    }, true);
    const low = computeBlobScore({
      posScore: 0.5, clsScore: 0, whiteScore: 0, peerScore: 0,
    }, true);
    assert.ok(high > low);
  });
});

describe('pickBestBlobInRange', () => {
  const scoreFns: ScoreFns = {
    cls: () => 0.5,
    white: () => 0.5,
    peer: () => 1,
  };

  it('picks blob near prediction', () => {
    const blobs = [blob(10, 10), blob(100, 100)];
    const pick = pickBestBlobInRange(blobs, { x: 12, y: 12 }, { x: 12, y: 12 }, 30, true, scoreFns);
    assert.equal(pick?.blob.cx, 10);
  });
});
