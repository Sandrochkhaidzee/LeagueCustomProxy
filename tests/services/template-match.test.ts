import {
  toGrayscale,
  circularMaskIndices,
  ncc,
  templateMatchScore,
  ssim,
  bestChampionMatch,
} from '../../src/services/template-match';

// Build a size×size RGBA array from a grayscale fill function f(x,y)->0..255.
function rgbaFrom(size: number, f: (x: number, y: number) => number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = f(x, y);
      const i = (y * size + x) * 4;
      out[i] = v; out[i + 1] = v; out[i + 2] = v; out[i + 3] = 255;
    }
  }
  return out;
}

describe('toGrayscale', () => {
  test('applies luma weights', () => {
    // one red pixel
    const g = toGrayscale([255, 0, 0, 255], 1, 1);
    expect(g[0]).toBeCloseTo(0.299 * 255, 3);
  });
  test('length is width*height', () => {
    expect(toGrayscale(new Uint8ClampedArray(4 * 4 * 4), 4, 4).length).toBe(16);
  });
});

describe('circularMaskIndices', () => {
  test('keeps interior, drops corners', () => {
    const idx = circularMaskIndices(8, 0);
    // corner (0,0) excluded
    expect(idx).not.toContain(0);
    // center-ish included
    const center = 4 * 8 + 4;
    expect(idx).toContain(center);
    // fewer than the full square
    expect(idx.length).toBeLessThan(64);
    expect(idx.length).toBeGreaterThan(30);
  });
});

describe('ncc', () => {
  const size = 16;
  const idx = circularMaskIndices(size, 0);

  test('identical patches → 1', () => {
    const a = toGrayscale(rgbaFrom(size, (x) => x * 10), size, size);
    expect(ncc(a, a, idx)).toBeCloseTo(1, 5);
  });

  test('brightness/contrast invariant (a vs 0.5*a + 40) → still ~1', () => {
    const a = toGrayscale(rgbaFrom(size, (x, y) => (x + y) * 6), size, size);
    const b = new Float32Array(a.length);
    for (let i = 0; i < a.length; i++) b[i] = 0.5 * a[i] + 40; // contrast + brightness shift
    expect(ncc(a, b, idx)).toBeCloseTo(1, 4);
  });

  test('inverted patch → -1', () => {
    const a = toGrayscale(rgbaFrom(size, (x) => x * 10), size, size);
    const b = new Float32Array(a.length);
    for (let i = 0; i < a.length; i++) b[i] = 255 - a[i];
    expect(ncc(a, b, idx)).toBeCloseTo(-1, 5);
  });

  test('flat patch (zero variance) → 0', () => {
    const a = toGrayscale(rgbaFrom(size, () => 128), size, size);
    const b = toGrayscale(rgbaFrom(size, (x) => x * 10), size, size);
    expect(ncc(a, b, idx)).toBe(0);
  });

  test('uncorrelated structured patches score well below 1', () => {
    const a = toGrayscale(rgbaFrom(size, (x) => x * 16), size, size);          // horizontal gradient
    const b = toGrayscale(rgbaFrom(size, (_x, y) => y * 16), size, size);      // vertical gradient
    expect(ncc(a, b, idx)).toBeLessThan(0.6);
  });
});

describe('templateMatchScore', () => {
  const size = 24;

  test('a template matched against itself → ~1', () => {
    const tpl = rgbaFrom(size, (x, y) => ((x * 7 + y * 13) % 256));
    expect(templateMatchScore(tpl, tpl, size)).toBeCloseTo(1, 5);
  });

  test('a champion template vs a flat "minion/structure" blob → ~0.5 (uncorrelated, rejected)', () => {
    const champ = rgbaFrom(size, (x, y) => ((x * 11 + y * 5) % 256));
    const minion = rgbaFrom(size, () => 90); // small flat dot
    const s = templateMatchScore(champ, minion, size);
    expect(s).toBeGreaterThan(0.4);
    expect(s).toBeLessThan(0.6); // far from a real match (~1)
  });

  test('output is in [0,1]', () => {
    const a = rgbaFrom(size, (x) => x * 10);
    const b = rgbaFrom(size, (x, y) => 255 - x * 10 - y);
    const s = templateMatchScore(a, b, size);
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(1);
  });
});

describe('ssim', () => {
  const size = 16;
  const idx = circularMaskIndices(size, 0);
  const gray = (f: (x: number, y: number) => number) => toGrayscale(rgbaFrom(size, f), size, size);

  test('identical patches → 1', () => {
    const a = gray((x, y) => (x * 7 + y * 11) % 256);
    expect(ssim(a, a, idx)).toBeCloseTo(1, 5);
  });
  test('a structured icon vs a flat minion dot scores low', () => {
    const champ = gray((x, y) => (x * 13 + y * 5) % 256);
    const minion = gray(() => 100);
    expect(ssim(champ, minion, idx)).toBeLessThan(0.3);
  });
  test('mild brightness drop (fog) on the same structure stays well above 0.3', () => {
    const a = gray((x, y) => 60 + ((x + y) * 6) % 180);
    const darker = new Float32Array(a.length);
    for (let i = 0; i < a.length; i++) darker[i] = a[i] * 0.6; // fog-of-war darkening
    expect(ssim(a, darker, idx)).toBeGreaterThan(0.3);
  });
});

describe('bestChampionMatch', () => {
  const size = 16;
  const idx = circularMaskIndices(size, 0);
  const gray = (f: (x: number, y: number) => number) => toGrayscale(rgbaFrom(size, f), size, size);

  test('picks the correct champion among several templates', () => {
    const teemo = gray((x, y) => (x * 17) % 256);
    const ahri = gray((x, y) => (y * 17) % 256);
    const zed = gray((x, y) => ((x ^ y) * 9) % 256);
    const templates = new Map([['Teemo', teemo], ['Ahri', ahri], ['Zed', zed]]);
    // A blob that is Teemo's icon, slightly darkened
    const blob = new Float32Array(teemo.length);
    for (let i = 0; i < teemo.length; i++) blob[i] = teemo[i] * 0.7;
    const m = bestChampionMatch(blob, templates, idx);
    expect(m?.name).toBe('Teemo');
    expect(m!.score).toBeGreaterThan(0.3);
  });

  test('returns null for empty template set', () => {
    expect(bestChampionMatch(gray(() => 1), new Map(), idx)).toBeNull();
  });
});
