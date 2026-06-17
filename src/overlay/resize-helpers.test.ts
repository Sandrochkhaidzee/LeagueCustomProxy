import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeDesiredHeight } from './resize-helpers.ts';

describe('computeDesiredHeight', () => {
  it('adds breathing room and clamps min', () => {
    assert.equal(computeDesiredHeight(120), 124);
    assert.equal(computeDesiredHeight(0), 120);
  });

  it('clamps max height', () => {
    assert.equal(computeDesiredHeight(5000), 1200);
  });
});
