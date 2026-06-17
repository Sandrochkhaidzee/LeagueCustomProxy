/** Time-based EMA on per-peer volume targets with per-tick slew cap. */
export function nextSmoothedVolume(
  prev: number | null,
  target: number,
  nowMs: number,
  lastUpdateMs: number,
  maxDeltaPerSec = 1.5,
): number {
  const clamped = Math.max(0, Math.min(1, target));
  if (prev === null) return clamped;
  const dtSec = (nowMs - lastUpdateMs) / 1000;
  const alpha = Math.min(0.3, 1 - Math.exp(-dtSec / 0.3));
  let next = prev * (1 - alpha) + clamped * alpha;
  const maxDelta = maxDeltaPerSec * Math.max(dtSec, 0.05);
  next = Math.max(prev - maxDelta, Math.min(prev + maxDelta, next));
  return Math.max(0, Math.min(1, next));
}
