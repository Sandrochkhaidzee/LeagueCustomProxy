import { classifyMinimapPixel, rgbToHsv } from '../../src/services/color-detect';

// Apply a gamma shift to RGB to simulate a player's brighter/darker display.
function gamma(rgb: [number, number, number], gm: number): [number, number, number] {
  return rgb.map(c => Math.min(255, Math.round(((c / 255) ** gm) * 255))) as [number, number, number];
}

describe('classifyMinimapPixel', () => {
  // Real measured ally-ring pixel values from harvested Garen/Mordekaiser
  // self-crops (v0.4.3 tuning). These MUST classify as teal — the old
  // r<100 gate wrongly rejected them.
  test('bright ally ring (real harvested values) classifies as teal', () => {
    expect(classifyMinimapPixel(186, 215, 229)).toBe(1); // Garen ring avg
    expect(classifyMinimapPixel(170, 220, 223)).toBe(1); // Mord ring avg
    expect(classifyMinimapPixel(67, 215, 229)).toBe(1);  // darker ring edge
  });

  test('still catches the dark teal the old gate handled', () => {
    expect(classifyMinimapPixel(80, 180, 175)).toBe(1);
  });

  test('rejects white / near-white (no cyan dominance)', () => {
    expect(classifyMinimapPixel(220, 225, 228)).toBe(0); // near-white highlight
    expect(classifyMinimapPixel(200, 200, 200)).toBe(0); // gray
  });

  test('rejects neutral terrain grays', () => {
    expect(classifyMinimapPixel(100, 105, 98)).toBe(0);
    expect(classifyMinimapPixel(60, 68, 52)).toBe(0); // jungle green-ish but dim
  });

  test('classifies enemy red ring as red', () => {
    expect(classifyMinimapPixel(200, 60, 60)).toBe(2);
    expect(classifyMinimapPixel(180, 40, 30)).toBe(2);
  });

  test('does not confuse red ring for teal or vice versa', () => {
    expect(classifyMinimapPixel(220, 230, 60)).not.toBe(2); // yellow-ish, not enemy red
    expect(classifyMinimapPixel(186, 215, 229)).not.toBe(2);
  });

  // The whole point of HSV: robust to per-player brightness/contrast/gamma.
  test('ally ring stays teal across gamma shifts (different display settings)', () => {
    const ring: [number, number, number] = [186, 215, 229];
    expect(classifyMinimapPixel(...gamma(ring, 0.6))).toBe(1); // much brighter
    expect(classifyMinimapPixel(...gamma(ring, 1.0))).toBe(1); // unchanged
    expect(classifyMinimapPixel(...gamma(ring, 1.6))).toBe(1); // much darker
  });

  test('ally ring stays teal when desaturated (low-saturation display)', () => {
    // Pull the ring toward gray but keep the cyan hue.
    expect(classifyMinimapPixel(150, 190, 200)).toBe(1);
  });
});

describe('rgbToHsv', () => {
  test('pure red → hue 0', () => { expect(rgbToHsv(255, 0, 0).h).toBeCloseTo(0, 1); });
  test('pure green → hue 120', () => { expect(rgbToHsv(0, 255, 0).h).toBeCloseTo(120, 1); });
  test('cyan → hue 180', () => { expect(rgbToHsv(0, 255, 255).h).toBeCloseTo(180, 1); });
  test('gray → saturation 0', () => { expect(rgbToHsv(128, 128, 128).s).toBe(0); });
  test('real ally-ring sample sits in the cyan band', () => {
    const { h } = rgbToHsv(186, 215, 229);
    expect(h).toBeGreaterThan(150);
    expect(h).toBeLessThan(215);
  });
});
