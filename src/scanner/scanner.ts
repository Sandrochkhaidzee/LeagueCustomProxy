// Scanner window — the transparent overlay that sits on top of the minimap.
// Hosts the tracking dot and (when Debug is on) the HSV-filtered debug image.
// Always click-through; never receives user input. Position + visibility are
// driven by events emitted from the panel window's orchestrator.

import { listen } from '@tauri-apps/api/event';

// Summoner's Rift map dimensions (matches src/core/types.ts MAP_DIMENSIONS)
const MAP_WIDTH = 14820;
const MAP_HEIGHT = 14881;

const scannerRoot = document.getElementById('scanner-root')!;
const trackingDot = document.getElementById('tracking-dot')!;

interface SceneUpdate {
  // The HSV-filtered minimap image to paint as the scanner's background, or null.
  filteredImageUrl: string | null;
  // Local player's tracked position in game coordinates, or null if not locked.
  lastPosition: { x: number; y: number } | null;
  // Whether the user has Debug toggled on. When false, hide all debug visuals.
  debugEnabled: boolean;
}

listen<SceneUpdate>('scanner:scene', (event) => {
  const { filteredImageUrl, lastPosition, debugEnabled } = event.payload;

  if (debugEnabled && filteredImageUrl) {
    scannerRoot.style.backgroundImage = 'url(' + filteredImageUrl + ')';
    scannerRoot.style.backgroundSize = '100% 100%';
    scannerRoot.style.backgroundRepeat = 'no-repeat';
    scannerRoot.style.boxShadow = 'inset 0 0 0 3px rgba(255, 0, 0, 0.85)';
  } else {
    scannerRoot.style.backgroundImage = '';
    scannerRoot.style.boxShadow = '';
  }

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
