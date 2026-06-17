import {
  sensitivityToThresholds,
  stepEnergyVad,
  bufferRms,
} from './vad-math';
import { nextSmoothedVolume } from '../peer-connection';

describe('sensitivityToThresholds', () => {
  it('lowers thresholds as sensitivity increases', () => {
    const low = sensitivityToThresholds(0);
    const high = sensitivityToThresholds(100);
    expect(high.open).toBeLessThan(low.open);
    expect(high.close).toBeLessThan(low.close);
  });
});

describe('stepEnergyVad', () => {
  const hangover = 4800;

  it('opens on loud signal', () => {
    const next = stepEnergyVad(0.05, { speechActive: false, hangoverSamplesRemaining: 0 }, 0.02, 0.015, hangover);
    expect(next.speechActive).toBe(true);
  });

  it('holds hangover after signal drops', () => {
    let state = stepEnergyVad(0.05, { speechActive: false, hangoverSamplesRemaining: 0 }, 0.02, 0.015, hangover);
    state = stepEnergyVad(0.001, state, 0.02, 0.015, hangover);
    expect(state.speechActive).toBe(true);
    expect(state.hangoverSamplesRemaining).toBeLessThan(hangover);
  });

  it('closes after hangover expires', () => {
    let state = { speechActive: true, hangoverSamplesRemaining: 2 };
    state = stepEnergyVad(0.001, state, 0.02, 0.015, hangover);
    state = stepEnergyVad(0.001, state, 0.02, 0.015, hangover);
    state = stepEnergyVad(0.001, state, 0.02, 0.015, hangover);
    expect(state.speechActive).toBe(false);
  });
});

describe('bufferRms', () => {
  it('returns 0 for silence', () => {
    expect(bufferRms(new Float32Array(128))).toBe(0);
  });
});

describe('nextSmoothedVolume slew', () => {
  it('caps large upward jumps', () => {
    const v = nextSmoothedVolume(0.1, 1.0, 1000, 900, 1.5);
    expect(v).toBeLessThan(0.5);
  });
});
