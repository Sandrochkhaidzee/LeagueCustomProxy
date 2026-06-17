import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizedCrossCorrelation } from './template-match-math.ts';

describe('normalizedCrossCorrelation', () => {
  it('returns ~1 for identical patterns', () => {
    const a = new Float32Array([0.1, 0.5, 0.9, 0.3]);
    const b = new Float32Array([0.1, 0.5, 0.9, 0.3]);
    assert.ok(normalizedCrossCorrelation(a, b) > 0.99);
  });

  it('returns low score for orthogonal patterns', () => {
    const a = new Float32Array([1, 0, 1, 0]);
    const b = new Float32Array([0, 1, 0, 1]);
    assert.ok(normalizedCrossCorrelation(a, b) < 0.5);
  });
});
