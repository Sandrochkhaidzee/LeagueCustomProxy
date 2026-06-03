// Minimap pixel color classification for blob detection: teal ally ring,
// red enemy ring, or neither. Pure + tested so the thresholds can be tuned
// against real data.
//
// v0.4.3 moved from RGB thresholds to HSV. Players run different in-game
// brightness / contrast / gamma / saturation, which shift the icon's raw RGB
// values — so absolute RGB gates (the old `r < 100`) are fragile across setups.
// HSV is far more robust: brightness/contrast/gamma mostly move VALUE, leaving
// HUE stable, so we key the detection on the cyan/red HUE with deliberately
// loose saturation + value floors. Hue ranges were derived from real harvested
// self-icon crops (ally ring measured ~185-200° cyan).

/** Convert 8-bit RGB to HSV. h in [0,360), s,v in [0,1]. */
export function rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = 60 * (((gn - bn) / d) % 6);
    else if (max === gn) h = 60 * ((bn - rn) / d + 2);
    else h = 60 * ((rn - gn) / d + 4);
  }
  if (h < 0) h += 360;
  const s = max === 0 ? 0 : d / max;
  return { h, s, v: max };
}

// Cyan ally-ring hue band (measured ~185-200° on real crops; widened for
// saturation/HUD variation). Saturation floor low enough to catch a
// desaturated display's faint ring, high enough to reject gray terrain;
// value floor rejects near-black fog.
const TEAL_HUE_MIN = 150;
const TEAL_HUE_MAX = 215;
// 0.10 floor: a very bright display (gamma ~0.6) desaturates the ring to
// ~0.117; gray terrain/near-white sit at ≤0.07, so 0.10 still rejects them.
const TEAL_SAT_MIN = 0.10;
const TEAL_VAL_MIN = 0.35;

// Enemy red ring sits at the hue wrap-around (~0° / 360°), high saturation.
const RED_HUE_LO = 18;   // 0..18
const RED_HUE_HI = 342;  // 342..360
const RED_SAT_MIN = 0.4;
const RED_VAL_MIN = 0.3;

/** 0 = neither, 1 = teal (ally), 2 = red (enemy). */
export function classifyMinimapPixel(r: number, g: number, b: number): 0 | 1 | 2 {
  const { h, s, v } = rgbToHsv(r, g, b);
  if (v < 0.2) return 0; // too dark to classify (fog / black)
  if (h >= TEAL_HUE_MIN && h <= TEAL_HUE_MAX && s >= TEAL_SAT_MIN && v >= TEAL_VAL_MIN) return 1;
  if ((h <= RED_HUE_LO || h >= RED_HUE_HI) && s >= RED_SAT_MIN && v >= RED_VAL_MIN) return 2;
  return 0;
}
