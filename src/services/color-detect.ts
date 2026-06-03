// Minimap pixel color classification for blob detection: teal ally ring,
// red enemy ring, or neither. Pure + tested so the thresholds can be tuned
// against real data.
//
// v0.4.3 retuned the teal test from REAL harvested crops (Garen + Mordekaiser
// self-icons). The ally ring is a BRIGHT cyan — measured r≈170-186, g≈215,
// b≈225 — not the dark teal the old `r < 100` gate assumed. That gate rejected
// ~80% of the actual ring pixels (they failed ONLY because red was too high),
// leaving blobs thin/undersized so the tracker kept dropping the champion
// ("no teal blobs"). The fix: detect cyan by DOMINANCE (green and blue both
// clearly exceed red) instead of an absolute red ceiling. This keeps rejecting
// white/gray (r≈g≈b) and enemy red (red dominant); minions/structures that
// share the ally color are rejected downstream by the blob size/fill filter
// and template matching.

/** 0 = neither, 1 = teal (ally), 2 = red (enemy). */
export function classifyMinimapPixel(r: number, g: number, b: number): 0 | 1 | 2 {
  // Teal/cyan ally border: green and blue are both bright AND both clearly
  // exceed red (cyan dominance), at any overall brightness.
  if (g > 120 && b > 120 && (g + b) > 280 && g > r + CYAN_MARGIN && b > r + CYAN_MARGIN) return 1;
  // Red enemy border: red dominant, green and blue low.
  if (r > 140 && g < 100 && b < 100) return 2;
  return 0;
}

// How much green and blue must exceed red for a pixel to count as cyan. Tuned
// from real crops: the bulk of the bright ally ring clears r+~30; 15 catches it
// with margin while still rejecting near-white (small channel spread).
const CYAN_MARGIN = 15;
