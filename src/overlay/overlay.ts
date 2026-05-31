interface NearbyPeer {
  summonerName: string;
  championName: string;
  team: 'ORDER' | 'CHAOS';
  isMuted: boolean;
  isMutedByLocal: boolean;
  isDead: boolean;
}

interface OverlayState {
  selfMuted: boolean;
  muteAll: boolean;
  nearbyPeers: NearbyPeer[];
  trackingState?: string;
  lastPosition?: { x: number; y: number } | null;
  filteredImageUrl?: string | null;
  detectedMinimapBounds?: { screenX: number; screenY: number; screenWidth: number; screenHeight: number } | null;
}

const playerList = document.getElementById('player-list')!;
const btnSelfMute = document.getElementById('btn-self-mute')!;
const btnMuteAll = document.getElementById('btn-mute-all')!;
const btnSettings = document.getElementById('btn-settings')!;
const btnDebug = document.getElementById('btn-debug')!;
const btnCollapse = document.getElementById('btn-collapse')!;
const panel = document.getElementById('panel')!;
const settingsPanel = document.getElementById('settings-panel')!;
const dragHandle = document.getElementById('drag-handle')!;
const trackingDot = document.getElementById('tracking-dot')!;
const minimapBorder = document.getElementById('minimap-border')!;

// Map dimensions for Summoner's Rift (for tracking dot position)
const MAP_WIDTH = 14820;
const MAP_HEIGHT = 14881;

// Debug overlay state (off by default)
let debugEnabled = false;

// Per-player volume cache (so sliders don't reset on re-render)
const playerVolumes: Map<string, number> = new Map();

// Tauri handles window dragging and resizing via its window config.
// The drag handle uses Tauri's built-in data-tauri-drag-region attribute
// (set in the HTML). No manual drag/resize logic needed.

// --- Controls ---
btnSelfMute.addEventListener('click', () => {
  const nowMuted = !btnSelfMute.classList.contains('active');
  btnSelfMute.classList.toggle('active', nowMuted);
  btnSelfMute.textContent = nowMuted ? 'MIC OFF' : 'MIC';
  sendToBackground('toggleSelfMute', {});
});

btnMuteAll.addEventListener('click', () => {
  const nowMuted = !btnMuteAll.classList.contains('active');
  btnMuteAll.classList.toggle('active', nowMuted);
  btnMuteAll.textContent = nowMuted ? 'ALL OFF' : 'VOL';
  sendToBackground('toggleMuteAll', {});
});

btnSettings.addEventListener('click', () => {
  settingsPanel.classList.toggle('hidden');
});

let collapsed = false;
btnCollapse.addEventListener('click', () => {
  collapsed = !collapsed;
  panel.classList.toggle('collapsed', collapsed);
  btnCollapse.textContent = collapsed ? '\u00AB' : '\u00BB';
  btnCollapse.title = collapsed ? 'Expand' : 'Collapse';
  // Close settings when collapsing
  if (collapsed) {
    settingsPanel.classList.add('hidden');
  }
});

const scanRateRow = document.getElementById('scan-rate-row')!;
btnDebug.addEventListener('click', () => {
  debugEnabled = !debugEnabled;
  btnDebug.textContent = debugEnabled ? 'ON' : 'OFF';
  btnDebug.classList.toggle('active', debugEnabled);
  scanRateRow.classList.toggle('hidden', !debugEnabled);
  // Immediately hide debug elements when toggled off
  if (!debugEnabled) {
    trackingDot.style.display = 'none';
    minimapBorder.style.backgroundImage = '';
    minimapBorder.style.boxShadow = '';
  } else {
    minimapBorder.style.boxShadow = 'inset 0 0 0 3px rgba(255, 0, 0, 0.85)';
  }
});

document.getElementById('input-mode')!.addEventListener('change', (e) => {
  const mode = (e.target as HTMLSelectElement).value;
  sendToBackground('updateSettings', { inputMode: mode });
});

const volumeInput = document.getElementById('input-volume') as HTMLInputElement;
const volumeLabel = document.getElementById('volume-label')!;
volumeInput.addEventListener('input', () => {
  const raw = parseInt(volumeInput.value);
  volumeLabel.textContent = String(raw);
  sendToBackground('updateSettings', { inputVolume: raw / 100 });
});

const sensitivityInput = document.getElementById('input-sensitivity') as HTMLInputElement;
const sensitivityLabel = document.getElementById('sensitivity-label')!;
sensitivityInput.addEventListener('input', () => {
  const raw = parseInt(sensitivityInput.value);
  sensitivityLabel.textContent = String(raw);
  // Map 0-100 → 0.0-0.5 for backend VAD threshold
  sendToBackground('updateSettings', { vadSensitivity: raw / 200 });
});

const scanRateInput = document.getElementById('input-scan-rate') as HTMLInputElement;
const scanRateLabel = document.getElementById('scan-rate-label')!;
scanRateInput.addEventListener('input', () => {
  const raw = parseInt(scanRateInput.value);
  scanRateLabel.textContent = String(raw);
  // Map 0-100 → 1-60 FPS for backend scan rate (default 50 → 30 FPS)
  const fps = Math.max(1, Math.round(1 + (raw / 100) * 59));
  sendToBackground('setScanRate', { fps });
});

function sendToBackground(action: string, payload: any): void {
  // In Tauri, both background and overlay run in the same WebView,
  // so we use window events for communication
  window.dispatchEvent(new CustomEvent('overlayAction', { detail: { action, payload } }));
}

// Report the panel's current size to Rust so the click-through hit-test
// follows collapse/expand/settings open.
const reportPanelSize = () => {
  sendToBackground('panelResize', {
    width: panel.offsetWidth,
    height: panel.offsetHeight,
  });
};
new ResizeObserver(reportPanelSize).observe(panel);
// Initial report once the layout has settled
requestAnimationFrame(reportPanelSize);

// --- Track active player row DOM elements for in-place updates ---
const playerRows: Map<string, {
  row: HTMLElement;
  nameSpan: HTMLElement;
  indicator: HTMLElement | null;
  volSlider: HTMLInputElement;
  muteBtn: HTMLButtonElement;
}> = new Map();

// Track whether a player slider is being actively dragged
let activeSliderPlayer: string | null = null;

function createPlayerRow(peer: NearbyPeer): HTMLElement {
  const row = document.createElement('div');
  row.className = 'player-row ' + (peer.team === 'ORDER' ? 'ally' : 'enemy');

  const nameSpan = document.createElement('span');
  nameSpan.className = 'player-name';
  nameSpan.textContent = peer.championName;
  row.appendChild(nameSpan);

  const indicator = document.createElement('span');
  indicator.className = 'player-muted-indicator';
  if (peer.isDead) {
    indicator.textContent = 'DEAD';
  } else if (peer.isMuted) {
    indicator.textContent = 'MUTED';
  } else {
    indicator.style.display = 'none';
  }
  row.appendChild(indicator);

  const volSlider = document.createElement('input') as HTMLInputElement;
  volSlider.type = 'range';
  volSlider.className = 'player-volume';
  volSlider.min = '0';
  volSlider.max = '100';
  volSlider.value = String(Math.round((playerVolumes.get(peer.summonerName) ?? 1.0) * 100));
  volSlider.addEventListener('mousedown', () => { activeSliderPlayer = peer.summonerName; });
  volSlider.addEventListener('mouseup', () => { activeSliderPlayer = null; });
  volSlider.addEventListener('input', () => {
    const vol = parseInt(volSlider.value) / 100;
    playerVolumes.set(peer.summonerName, vol);
    sendToBackground('setPlayerVolume', { name: peer.summonerName, volume: vol });
  });
  row.appendChild(volSlider);

  const muteBtn = document.createElement('button') as HTMLButtonElement;
  muteBtn.className = 'player-mute-btn' + (peer.isMutedByLocal ? ' muted' : '');
  muteBtn.textContent = peer.isMutedByLocal ? 'MUTED' : 'MUTE';
  muteBtn.addEventListener('click', () => {
    sendToBackground('toggleMutePlayer', { name: peer.summonerName });
  });
  row.appendChild(muteBtn);

  playerRows.set(peer.summonerName, { row, nameSpan, indicator, volSlider, muteBtn });
  return row;
}

function updatePlayerRow(peer: NearbyPeer): void {
  const entry = playerRows.get(peer.summonerName);
  if (!entry) return;

  // Update indicator
  if (peer.isDead) {
    entry.indicator!.textContent = 'DEAD';
    entry.indicator!.style.display = '';
  } else if (peer.isMuted) {
    entry.indicator!.textContent = 'MUTED';
    entry.indicator!.style.display = '';
  } else {
    entry.indicator!.style.display = 'none';
  }

  // Don't touch slider if user is actively dragging it
  if (activeSliderPlayer !== peer.summonerName) {
    const expected = String(Math.round((playerVolumes.get(peer.summonerName) ?? 1.0) * 100));
    if (entry.volSlider.value !== expected) {
      entry.volSlider.value = expected;
    }
  }

  // Update mute button
  const isMuted = peer.isMutedByLocal;
  entry.muteBtn.className = 'player-mute-btn' + (isMuted ? ' muted' : '');
  entry.muteBtn.textContent = isMuted ? 'MUTED' : 'MUTE';
}

// --- Render state ---
function renderState(state: OverlayState): void {
  btnSelfMute.classList.toggle('active', state.selfMuted);
  btnSelfMute.textContent = state.selfMuted ? 'MIC OFF' : 'MIC';
  btnMuteAll.classList.toggle('active', state.muteAll);
  btnMuteAll.textContent = state.muteAll ? 'ALL OFF' : 'VOL';

  // Build set of current peer names for diffing
  const currentNames = new Set(state.nearbyPeers.map(p => p.summonerName));

  // Remove rows for peers that left
  for (const [name, entry] of playerRows) {
    if (!currentNames.has(name)) {
      entry.row.remove();
      playerRows.delete(name);
    }
  }

  // Update existing rows or create new ones
  for (const peer of state.nearbyPeers) {
    if (playerRows.has(peer.summonerName)) {
      updatePlayerRow(peer);
    } else {
      playerList.appendChild(createPlayerRow(peer));
    }
  }

  // Show/hide empty state
  const emptyState = playerList.querySelector('.empty-state');
  if (state.nearbyPeers.length === 0) {
    if (!emptyState) {
      const emptyDiv = document.createElement('div');
      emptyDiv.className = 'empty-state';
      emptyDiv.textContent = 'Waiting for nearby players...';
      playerList.appendChild(emptyDiv);
    }
  } else if (emptyState) {
    emptyState.remove();
  }

  // Debug info: tracking state + position (only when debug enabled)
  const dbgEl = document.getElementById('debug-info')!;
  if (debugEnabled && (state.trackingState || state.lastPosition)) {
    const parts: string[] = [];
    if (state.trackingState) parts.push('tracking: ' + state.trackingState);
    if (state.lastPosition) {
      parts.push('pos: (' + Math.round(state.lastPosition.x) + ',' + Math.round(state.lastPosition.y) + ')');
    }
    dbgEl.textContent = parts.join(' | ');
    dbgEl.classList.remove('hidden');
  } else {
    dbgEl.classList.add('hidden');
  }

  // Update tracking dot position on minimap border (only when debug enabled)
  if (debugEnabled && state.lastPosition && state.lastPosition.x > 0 && state.lastPosition.y > 0) {
    const relX = state.lastPosition.x / MAP_WIDTH;
    const relY = 1 - state.lastPosition.y / MAP_HEIGHT;
    trackingDot.style.left = (relX * 100) + '%';
    trackingDot.style.top = (relY * 100) + '%';
    trackingDot.style.display = 'block';
  } else {
    trackingDot.style.display = 'none';
  }

  // Update filtered debug image on minimap border (only when debug enabled)
  if (debugEnabled && state.filteredImageUrl) {
    minimapBorder.style.backgroundImage = 'url(' + state.filteredImageUrl + ')';
    minimapBorder.style.backgroundSize = '100% 100%';
    minimapBorder.style.backgroundRepeat = 'no-repeat';
  } else if (!debugEnabled) {
    minimapBorder.style.backgroundImage = '';
  }
}

// --- Listen for state updates from background ---
window.addEventListener('overlayUpdate', ((event: CustomEvent) => {
  renderState(event.detail);
}) as EventListener);

console.log('LoLProxChat overlay loaded');

export {};
