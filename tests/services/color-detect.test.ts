import { classifyMinimapPixel } from '../../src/services/color-detect';

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
});
