import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeFinalPeerVolume,
  resolveProximityTargets,
} from './audio-volume.ts';

describe('computeFinalPeerVolume', () => {
  it('multiplies proximity and slider', () => {
    assert.equal(computeFinalPeerVolume(0.5, 0.8), 0.4);
  });

  it('clamps inputs', () => {
    assert.equal(computeFinalPeerVolume(2, -1), 0);
  });
});

describe('resolveProximityTargets', () => {
  it('fills missing peers with zero', () => {
    const m = resolveProximityTargets({ Alice: 0.5 }, ['Alice', 'Bob']);
    assert.equal(m.get('Alice'), 0.5);
    assert.equal(m.get('Bob'), 0);
  });
});
