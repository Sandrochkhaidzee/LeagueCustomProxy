import { computeFinalPeerVolume } from '../../src/services/audio';

describe('computeFinalPeerVolume', () => {
  test('proximity × slider when both in [0, 1]', () => {
    expect(computeFinalPeerVolume(0.5, 0.5)).toBe(0.25);
    expect(computeFinalPeerVolume(0.8, 0.4)).toBeCloseTo(0.32);
  });

  test('proximity 0 always returns 0 regardless of slider', () => {
    // The exact scenario from issue #7 — when the user's proximity volume
    // for a peer is 0 (e.g., a clock-skewed peer whose blob the server
    // rejected), moving the slider must NOT produce audible playback.
    expect(computeFinalPeerVolume(0, 0)).toBe(0);
    expect(computeFinalPeerVolume(0, 0.5)).toBe(0);
    expect(computeFinalPeerVolume(0, 1.0)).toBe(0);
  });

  test('slider 0 always returns 0 (per-player mute path)', () => {
    expect(computeFinalPeerVolume(0.8, 0)).toBe(0);
    expect(computeFinalPeerVolume(1.0, 0)).toBe(0);
  });

  test('clamps proximity to [0, 1] defensively', () => {
    expect(computeFinalPeerVolume(-0.5, 1.0)).toBe(0);
    expect(computeFinalPeerVolume(1.5, 1.0)).toBe(1);
  });

  test('clamps slider to [0, 1] defensively', () => {
    expect(computeFinalPeerVolume(0.5, 2.0)).toBe(0.5);
    expect(computeFinalPeerVolume(0.5, -1)).toBe(0);
  });

  test('proximity 1.0 × slider passes the slider through', () => {
    expect(computeFinalPeerVolume(1.0, 0.7)).toBeCloseTo(0.7);
  });
});
