/** Pure volume helpers — testable without pulling in the full AudioService graph. */

export function computeFinalPeerVolume(proximityVol: number, sliderVol: number): number {
  const p = Math.max(0, Math.min(1, proximityVol));
  const s = Math.max(0, Math.min(1, sliderVol));
  return p * s;
}

export function resolveProximityTargets(
  responseVolumes: Record<string, number>,
  connectedPeerNames: Iterable<string>,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const [name, v] of Object.entries(responseVolumes)) out.set(name, v);
  for (const name of connectedPeerNames) {
    if (!out.has(name)) out.set(name, 0);
  }
  return out;
}
