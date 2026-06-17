/**
 * Pure VAD helpers — shared by the AudioWorklet processor and unit tests.
 */

/** Map UI sensitivity 0–100 to RMS open/close thresholds (higher = more sensitive). */
export function sensitivityToThresholds(sensitivity: number): { open: number; close: number } {
  const s = Math.max(0, Math.min(100, sensitivity));
  const factor = 1 - (s / 100) * 0.85;
  return {
    open: 0.02 * factor,
    close: 0.015 * factor,
  };
}

export interface EnergyVadState {
  speechActive: boolean;
  hangoverSamplesRemaining: number;
}

/**
 * One energy-VAD step with hysteresis and hangover.
 * `hangoverSteps` = number of RMS windows to hold open after signal drops below close.
 */
export function stepEnergyVad(
  rms: number,
  state: EnergyVadState,
  openThreshold: number,
  closeThreshold: number,
  hangoverSteps: number,
): EnergyVadState {
  if (rms >= openThreshold) {
    return { speechActive: true, hangoverSamplesRemaining: hangoverSteps };
  }
  if (state.speechActive) {
    if (rms >= closeThreshold) {
      return { speechActive: true, hangoverSamplesRemaining: hangoverSteps };
    }
    const remaining = state.hangoverSamplesRemaining - 1;
    if (remaining > 0) {
      return { speechActive: true, hangoverSamplesRemaining: remaining };
    }
    return { speechActive: false, hangoverSamplesRemaining: 0 };
  }
  return { speechActive: false, hangoverSamplesRemaining: 0 };
}

/** RMS of a float32 buffer (peak-style average energy). */
export function bufferRms(buf: Float32Array, len?: number): number {
  const n = len ?? buf.length;
  if (n <= 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    sumSq += buf[i] * buf[i];
  }
  return Math.sqrt(sumSq / n);
}

/** High-pass emphasis to reduce keyboard thump false-positives (one-pole). */
export function highPassSample(sample: number, prevIn: number, prevOut: number, coeff: number): {
  out: number;
  prevIn: number;
  prevOut: number;
} {
  const out = coeff * (prevOut + sample - prevIn);
  return { out, prevIn: sample, prevOut: out };
}
