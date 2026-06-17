/**
 * Normalized cross-correlation between two equal-length grayscale vectors (0–1).
 * Returns 0–1 where 1 = identical pattern.
 */
export function normalizedCrossCorrelation(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let sumA = 0;
  let sumB = 0;
  for (let i = 0; i < n; i++) {
    sumA += a[i];
    sumB += b[i];
  }
  const meanA = sumA / n;
  const meanB = sumB / n;
  let num = 0;
  let denA = 0;
  let denB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }
  const den = Math.sqrt(denA * denB);
  if (den <= 1e-9) return 0;
  const ncc = num / den;
  return Math.max(0, Math.min(1, (ncc + 1) / 2));
}

/** Resize RGBA crop to 32×32 grayscale floats (0–1). */
export function cropToGrayscale32(
  data: Uint8ClampedArray,
  srcW: number,
  cropX: number,
  cropY: number,
  cropW: number,
  cropH: number,
): Float32Array {
  const out = new Float32Array(32 * 32);
  for (let oy = 0; oy < 32; oy++) {
    for (let ox = 0; ox < 32; ox++) {
      const sx = cropX + Math.floor((ox / 32) * cropW);
      const sy = cropY + Math.floor((oy / 32) * cropH);
      const idx = (sy * srcW + sx) * 4;
      const r = data[idx] ?? 0;
      const g = data[idx + 1] ?? 0;
      const b = data[idx + 2] ?? 0;
      out[oy * 32 + ox] = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    }
  }
  return out;
}
