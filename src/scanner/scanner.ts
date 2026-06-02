// Scanner window — the transparent overlay that sits on top of the minimap.
// Hosts the tracking dot only. The HSV-filtered debug image used to be
// painted here too, but that fed back into the next capture frame and forced
// us to set WDA_EXCLUDEFROMCAPTURE, which broke ShadowPlay / OBS recording
// of the whole app. Filtered image now renders as a thumbnail inside the
// panel window's Settings area instead.

import { listen } from '@tauri-apps/api/event';

// Summoner's Rift map dimensions (matches src/core/types.ts MAP_DIMENSIONS)
const MAP_WIDTH = 14820;
const MAP_HEIGHT = 14881;

const scannerRoot = document.getElementById('scanner-root')!;
const trackingDot = document.getElementById('tracking-dot')!;

interface SceneUpdate {
  // Local player's tracked position in game coordinates, or null if not locked.
  lastPosition: { x: number; y: number } | null;
  // Whether the user has Debug toggled on. When false, hide all debug visuals.
  debugEnabled: boolean;
}

listen<SceneUpdate>('scanner:scene', (event) => {
  const { lastPosition, debugEnabled } = event.payload;

  // Red border around the detected minimap region — visual sanity check that
  // the scanner is positioned correctly. Bright red is well outside the teal
  // HSV filter range, so capturing it doesn't trigger a feedback loop.
  scannerRoot.style.boxShadow = debugEnabled
    ? 'inset 0 0 0 3px rgba(255, 0, 0, 0.85)'
    : '';

  if (debugEnabled && lastPosition && lastPosition.x > 0 && lastPosition.y > 0) {
    const relX = lastPosition.x / MAP_WIDTH;
    const relY = 1 - lastPosition.y / MAP_HEIGHT;
    trackingDot.style.left = (relX * 100) + '%';
    trackingDot.style.top = (relY * 100) + '%';
    trackingDot.style.display = 'block';
  } else {
    trackingDot.style.display = 'none';
  }
});

export {};
