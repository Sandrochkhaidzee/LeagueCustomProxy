import type { InputMode } from '../core/types';

/** Header LIVE/IDLE — voice activity for VAD; key held for PTT. */
export function isTransmitIndicatorLive(
  inputMode: InputMode,
  selfMuted: boolean,
  speechActive: boolean,
  pttHeld: boolean,
): boolean {
  if (selfMuted) return false;
  if (inputMode === 'ptt') return pttHeld;
  if (inputMode === 'vad') return speechActive;
  return false;
}
