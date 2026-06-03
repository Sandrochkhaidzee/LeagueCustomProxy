// Per-game template matching for champion-icon identity (v0.4 CV overhaul).
//
// Replaces the 172-class ONNX classifier's role of answering "is this blob the
// champion X?" with a direct comparison of the detected blob crop against the
// actual icon of champion X (fetched at game start — we know the exact 10
// champions). Validated approach: LOL_Minimap_Tracker ships SSIM template
// matching; NCCNet (arXiv:1705.08593) shows normalized cross-correlation in a
// (learned) feature space significantly reduces false matches. We use plain
// NCC here — it is brightness/contrast invariant (subtracts the mean, divides
// by the std), which matters because real minimap icons are darkened by
// fog-of-war and tinted by team-color rings.
//
// Why this fixes the observed failures: a minion dot or a turret icon has
// near-zero correlation with a champion portrait, so it is rejected for free
// — the classifier had to actively distinguish them and failed ("clinging to
// minions and structures"). And there is no per-champion training, so there
// is no "weak class" (e.g. Teemo).
//
// All functions are pure for unit testing. The DOM/canvas crop+resize lives in
// the caller (tracking.ts / champion-icons.ts).

/**
 * Convert packed RGBA bytes to a single-channel grayscale Float32Array using
 * the standard luma weights. Length = width*height.
 */
export function toGrayscale(rgba: Uint8ClampedArray | Uint8Array | number[], width: number, height: number): Float32Array {
  const n = width * height;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    out[i] = 0.299 * r + 0.587 * g + 0.114 * b;
  }
  return out;
}

/**
 * Indices of the pixels that fall inside the inscribed circle of a size×size
 * square. Minimap icons are circular, and the corners are background/ring —
 * comparing only the circular interior removes the team-color ring and the
 * dark corners from the correlation, which would otherwise dominate.
 *
 * `insetFrac` shrinks the circle slightly (default 0.06) to drop the colored
 * border ring at the very edge.
 */
export function circularMaskIndices(size: number, insetFrac = 0.06): number[] {
  const c = (size - 1) / 2;
  const r = c * (1 - insetFrac);
  const r2 = r * r;
  const idx: number[] = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - c;
      const dy = y - c;
      if (dx * dx + dy * dy <= r2) idx.push(y * size + x);
    }
  }
  return idx;
}

/**
 * Normalized cross-correlation of two equal-length grayscale arrays over the
 * given pixel indices. Returns a value in [-1, 1] (1 = identical structure,
 * brightness/contrast invariant). Returns 0 when either patch is flat (zero
 * variance) — no structure to correlate.
 */
export function ncc(a: Float32Array, b: Float32Array, indices: number[]): number {
  const n = indices.length;
  if (n === 0) return 0;

  let meanA = 0;
  let meanB = 0;
  for (const i of indices) {
    meanA += a[i];
    meanB += b[i];
  }
  meanA /= n;
  meanB /= n;

  let num = 0;
  let denA = 0;
  let denB = 0;
  for (const i of indices) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }
  const den = Math.sqrt(denA * denB);
  if (den === 0) return 0;
  return num / den;
}

/**
 * Convenience: NCC between a blob crop and a template, both supplied as RGBA
 * byte arrays of size×size, compared over the circular interior. Result is
 * remapped from [-1, 1] to [0, 1] so it drops into the existing 0–1 composite
 * scoring (0.5 = uncorrelated, 1 = perfect match, <0.5 = anti-correlated).
 */
export function templateMatchScore(
  blobRgba: Uint8ClampedArray | Uint8Array | number[],
  templateRgba: Uint8ClampedArray | Uint8Array | number[],
  size: number,
  maskIndices?: number[],
): number {
  const a = toGrayscale(blobRgba, size, size);
  const b = toGrayscale(templateRgba, size, size);
  const idx = maskIndices ?? circularMaskIndices(size);
  const r = ncc(a, b, idx);
  return (r + 1) / 2;
}
