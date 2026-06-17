import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  sensitivityToThresholds,
  stepEnergyVad,
  bufferRms,
} from './vad-math.ts';
import { nextSmoothedVolume } from '../volume-slew.ts';

describe('sensitivityToThresholds', () => {
  it('lowers thresholds as sensitivity increases', () => {
    const low = sensitivityToThresholds(0);
    const high = sensitivityToThresholds(100);
    assert.ok(high.open < low.open);
    assert.ok(high.close < low.close);
  });
});

describe('stepEnergyVad', () => {
  const hangover = 4800;

  it('opens on loud signal', () => {
    const next = stepEnergyVad(0.05, { speechActive: false, hangoverSamplesRemaining: 0 }, 0.02, 0.015, hangover);
    assert.equal(next.speechActive, true);
  });

  it('holds hangover after signal drops', () => {
    let state = stepEnergyVad(0.05, { speechActive: false, hangoverSamplesRemaining: 0 }, 0.02, 0.015, hangover);
    state = stepEnergyVad(0.001, state, 0.02, 0.015, hangover);
    assert.equal(state.speechActive, true);
    assert.ok(state.hangoverSamplesRemaining < hangover);
  });

  it('closes after hangover expires', () => {
    let state = { speechActive: true, hangoverSamplesRemaining: 2 };
    state = stepEnergyVad(0.001, state, 0.02, 0.015, hangover);
    state = stepEnergyVad(0.001, state, 0.02, 0.015, hangover);
    state = stepEnergyVad(0.001, state, 0.02, 0.015, hangover);
    assert.equal(state.speechActive, false);
  });
});

describe('bufferRms', () => {
  it('returns 0 for silence', () => {
    assert.equal(bufferRms(new Float32Array(128)), 0);
  });
});

describe('nextSmoothedVolume slew', () => {
  it('caps large upward jumps', () => {
    const v = nextSmoothedVolume(0.1, 1.0, 1000, 900, 1.5);
    assert.ok(v < 0.5);
  });
});
