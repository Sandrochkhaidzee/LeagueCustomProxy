import { invoke } from '@tauri-apps/api/core';
import { setLoggingEnabled } from '../core/logging';
import { listen, emit } from '@tauri-apps/api/event';
import {
  getStoredServerEndpointFields,
  getStoredConnectionName,
  setStoredServerEndpoint,
  setStoredConnectionName,
  normalizeConnectionName,
  clearStoredServerUrl,
  isServerUrlConfigured,
} from '../core/server-prefs';
import { buildServerUrl, parseServerEndpoint, type ServerEndpointFields } from '../core/server-endpoint';
import { probeRelayStatus, probeSignalingServer } from '../core/config';
import {
  checkForUpdate,
  downloadAndApply,
  formatInvokeError,
} from '../services/updater';
import {
  getStoredInputDeviceId,
  setStoredInputDeviceId,
  getStoredOutputDeviceId,
  setStoredOutputDeviceId,
  listAudioDevices,
  probeMicPermission,
} from '../services/devices';
import { loadAudioSettings, saveAudioSettings } from '../services/audio-prefs';
import type { InputMode } from '../core/types';
import { computeDesiredHeight } from './resize-helpers';
import { browserKeyToWin32Vk, humanizeVk } from '../core/keymap';
import { IS_DEV_BUILD } from '../core/build-flags';
import '../core/window-globals';

// v0.3 (#11): dynamic overlay-window resize so the panel grows to fit
// debug-thumbnail / settings content and shrinks back when they collapse.
// requestAnimationFrame-batched so we don't ping Rust at full frame rate
// when ResizeObserver fires rapidly (image load, etc).
let resizeQueued = false;
function syncOverlayHeight(): void {
  if (resizeQueued) return;
  resizeQueued = true;
  requestAnimationFrame(() => {
    resizeQueued = false;
    const panel = document.querySelector('.panel') as HTMLElement | null;
    if (!panel) return;
    // scrollHeight is in logical CSS px; the Rust side sizes the window in
    // PHYSICAL px (and so does the click-through hit-rect, which is compared
    // against physical Win32 cursor coords). Multiply by devicePixelRatio so
    // the window fits its content on scaled displays — without this a 125/150%
    // laptop got a too-short window and clipped the debug thumbnail, while a
    // 100% ultrawide looked fine. Matches the panelResize convention below.
    const dpr = window.devicePixelRatio || 1;
    const desired = computeDesiredHeight(Math.ceil(panel.scrollHeight));
    sendToBackground('resizeOverlay', { height: Math.round(desired * dpr) });
  });
}

interface NearbyPeer {
  summonerName: string;
  championName: string;
  team: 'ORDER' | 'CHAOS';
  isMuted: boolean;
  isMutedByLocal: boolean;
  isDead: boolean;
  isSpeaking?: boolean;
}

interface OverlayState {
  selfMuted: boolean;
  muteAll: boolean;
  nearbyPeers: NearbyPeer[];
  micLevel?: number;
  micTransmitting?: boolean;
  inputMode?: InputMode | null;
  trackingState?: string;
  lastPosition?: { x: number; y: number } | null;
  filteredImageUrl?: string | null;
  detectedMinimapBounds?: { screenX: number; screenY: number; screenWidth: number; screenHeight: number } | null;
  localTeam?: 'ORDER' | 'CHAOS' | null;
  lifecycleStatus?: string;
}

const playerList = document.getElementById('player-list')!;
const btnSettings = document.getElementById('btn-settings')!;
const btnCollapse = document.getElementById('btn-collapse')!;
const btnClose = document.getElementById('btn-close')!;
const panel = document.getElementById('panel')!;
const connectStatus = document.getElementById('connect-status')!;
const settingsPanel = document.getElementById('settings-panel')!;
const transmitStatus = document.getElementById('transmit-status')!;
const transmitLabel = document.getElementById('transmit-label')!;
const collapseChevron = document.getElementById('collapse-chevron')!;
const calibrateRow = document.getElementById('calibrate-row')!;
const btnAlignScanner = document.getElementById('btn-align-scanner') as HTMLButtonElement;
const btnCalibrateDone = document.getElementById('btn-calibrate-done') as HTMLButtonElement;
const relayStatusEl = document.getElementById('relay-status')!;
const serverProtocolSelect = document.getElementById('server-protocol') as HTMLSelectElement;
const connectionNameInput = document.getElementById('connection-name') as HTMLInputElement;
const serverHostInput = document.getElementById('server-host') as HTMLInputElement;
const serverPortInput = document.getElementById('server-port') as HTMLInputElement;
const btnConnectServer = document.getElementById('btn-connect-server') as HTMLButtonElement;

const PANEL_COLLAPSED_KEY = 'lolproxchat.panelCollapsed';

function isPanelCollapsed(): boolean {
  return localStorage.getItem(PANEL_COLLAPSED_KEY) === '1';
}

function setPanelCollapsed(collapsed: boolean): void {
  localStorage.setItem(PANEL_COLLAPSED_KEY, collapsed ? '1' : '0');
  panel.classList.toggle('collapsed', collapsed);
  collapseChevron.style.transform = collapsed ? 'rotate(-90deg)' : '';
  syncOverlayHeight();
}

if (isPanelCollapsed()) {
  setPanelCollapsed(true);
}

btnCollapse.addEventListener('click', (e) => {
  e.preventDefault();
  e.stopPropagation();
  setPanelCollapsed(!panel.classList.contains('collapsed'));
});

const btnDebug = IS_DEV_BUILD ? document.getElementById('btn-debug')! : null;

let debugEnabled = false;
if (IS_DEV_BUILD) {
  setLoggingEnabled(false);
} else {
  // Strip dev-only DOM before any code touches those nodes (see vadEngineSelect guard below).
  document.querySelectorAll('.dev-only').forEach((el) => el.remove());
  setLoggingEnabled(false);
  window.__lolproxchat_debug_enabled = false;
}

// Per-player volume cache (so sliders don't reset on re-render)
const playerVolumes: Map<string, number> = new Map();

// Tauri handles window dragging and resizing via its window config.
// The drag handle uses Tauri's built-in data-tauri-drag-region attribute
// (set in the HTML). No manual drag/resize logic needed.

// --- Header controls ---
btnClose.addEventListener('click', (e) => {
  e.preventDefault();
  e.stopPropagation();
  void (async () => {
    if (isServerUrlConfigured()) {
      await window.__lolproxchat_shutdown?.();
    }
    await invoke('exit_app');
  })().catch(() => window.close());
});

btnSettings.addEventListener('click', () => {
  if (panel.classList.contains('collapsed')) {
    setPanelCollapsed(false);
  }
  settingsPanel.classList.toggle('hidden');
  if (!settingsPanel.classList.contains('hidden')) {
    sendToBackground('resumeAudio', {});
    refreshDeviceLists();
    void refreshRelayStatus();
    const mode = (document.getElementById('input-mode') as HTMLSelectElement).value;
    if (shouldRunMicMonitor(mode)) {
      sendToBackground('ensureMicMonitor', {});
    }
  }
  syncOverlayHeight();
});

panel.addEventListener('pointerdown', () => {
  sendToBackground('resumeAudio', {});
});

// --- Audio device pickers ---
const inputDeviceSelect = document.getElementById('input-device') as HTMLSelectElement;
const outputDeviceSelect = document.getElementById('output-device') as HTMLSelectElement;

async function refreshDeviceLists(): Promise<void> {
  try {
    let { inputs, outputs } = await listAudioDevices();
    // Empty labels mean the user hasn't granted mic permission yet. Trigger
    // a one-shot probe so labels populate; then re-enumerate.
    if (inputs.some((d) => !d.label) || outputs.some((d) => !d.label)) {
      try {
        await probeMicPermission();
        ({ inputs, outputs } = await listAudioDevices());
      } catch {
        // User denied or no mic present — fall through with whatever labels we have
      }
    }
    populateDeviceSelect(inputDeviceSelect, inputs, getStoredInputDeviceId());
    populateDeviceSelect(outputDeviceSelect, outputs, getStoredOutputDeviceId());
  } catch (e) {
    console.warn('[Overlay] device enumeration failed:', e);
  }
}

function populateDeviceSelect(
  select: HTMLSelectElement,
  devices: MediaDeviceInfo[],
  selectedId: string | null,
): void {
  const defaultOpt = document.createElement('option');
  defaultOpt.value = '';
  defaultOpt.textContent = 'Default';
  const opts: HTMLOptionElement[] = [defaultOpt];
  for (const d of devices) {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || `(unnamed ${d.kind})`;
    opts.push(opt);
  }
  select.replaceChildren(...opts);
  select.value = selectedId && devices.some((d) => d.deviceId === selectedId) ? selectedId : '';
}

inputDeviceSelect.addEventListener('change', () => {
  const id = inputDeviceSelect.value || null;
  setStoredInputDeviceId(id);
  sendToBackground('setInputDevice', { id });
});

outputDeviceSelect.addEventListener('change', () => {
  const id = outputDeviceSelect.value || null;
  setStoredOutputDeviceId(id);
  sendToBackground('setOutputDevice', { id });
});

// Refresh if user plugs / unplugs a device while the panel is open
navigator.mediaDevices.addEventListener('devicechange', () => {
  if (!settingsPanel.classList.contains('hidden')) {
    refreshDeviceLists();
  }
});

const scanRateRow = IS_DEV_BUILD ? document.getElementById('scan-rate-row') : null;
const btnCheckUpdate = document.getElementById('btn-check-update') as HTMLButtonElement;
const updateStatus = document.getElementById('update-status')!;
const btnCheckUpdateGate = document.getElementById('btn-check-update-gate') as HTMLButtonElement;
const updateStatusGate = document.getElementById('update-status-gate')!;

async function runUpdateCheck(statusEl: HTMLElement): Promise<void> {
  statusEl.textContent = 'Checking for updates…';
  try {
    const info = await checkForUpdate();
    if (info.update_available && info.download_url) {
      statusEl.textContent = 'Update available: v' + info.latest_version + ' — applying…';
      await downloadAndApply(info.download_url);
    } else if (info.update_available && !info.download_url) {
      statusEl.textContent = 'Update v' + info.latest_version
        + ' exists but no leagueproxy.exe on the release';
    } else {
      statusEl.textContent = 'Up to date (v' + info.current_version + ')';
    }
  } catch (e) {
    statusEl.textContent = 'Update check failed: ' + formatInvokeError(e);
  }
}

btnCheckUpdate.addEventListener('click', () => {
  void runUpdateCheck(updateStatus);
});
btnCheckUpdateGate.addEventListener('click', () => {
  void runUpdateCheck(updateStatusGate);
});

async function refreshRelayStatus(): Promise<void> {
  if (!isServerUrlConfigured()) {
    relayStatusEl.textContent = 'Not configured';
    relayStatusEl.className = 'relay-status';
    return;
  }
  relayStatusEl.textContent = 'Checking…';
  relayStatusEl.className = 'relay-status';
  try {
    const status = await probeRelayStatus(true);
    if (status === 'turn') {
      relayStatusEl.textContent = 'OK (TURN relay)';
      relayStatusEl.classList.add('ok');
    } else if (status === 'stun-only') {
      relayStatusEl.textContent = 'STUN only (LAN OK)';
      relayStatusEl.classList.add('warn');
    } else {
      relayStatusEl.textContent = 'Unknown';
    }
  } catch {
    relayStatusEl.textContent = 'Check failed';
  }
}

function readServerEndpointFields(): ServerEndpointFields {
  return {
    protocol: serverProtocolSelect.value,
    host: serverHostInput.value,
    port: serverPortInput.value,
  };
}

function applyServerEndpointFields(fields: ServerEndpointFields): void {
  serverProtocolSelect.value = fields.protocol;
  serverHostInput.value = fields.host;
  serverPortInput.value = fields.port;
}

function applyConnectionNameField(): void {
  connectionNameInput.value = getStoredConnectionName();
}

function clearServerEndpointForm(): void {
  connectionNameInput.value = '';
  serverProtocolSelect.selectedIndex = 0;
  serverHostInput.value = '';
  serverPortInput.value = '';
}

function showConnectGate(): void {
  panel.classList.remove('connected');
  if (panel.classList.contains('collapsed')) {
    setPanelCollapsed(false);
  }
  settingsPanel.classList.add('hidden');
  clearServerEndpointForm();
  connectStatus.textContent = '';
  connectStatus.className = 'connect-status';
  connectionNameInput.focus();
  syncOverlayHeight();
}

function showMainApp(): void {
  panel.classList.add('connected');
  applyServerEndpointFields(getStoredServerEndpointFields());
  syncOverlayHeight();
}

async function connectToServer(fields: ServerEndpointFields): Promise<boolean> {
  const parsed = parseServerEndpoint(fields);
  if (!parsed.ok) {
    connectStatus.className = 'connect-status error';
    connectStatus.textContent = parsed.error;
    syncOverlayHeight();
    return false;
  }

  btnConnectServer.disabled = true;
  connectStatus.className = 'connect-status';
  connectStatus.textContent = 'Checking server…';
  syncOverlayHeight();

  const probe = await probeSignalingServer(fields);
  btnConnectServer.disabled = false;

  if (!probe.ok) {
    connectStatus.textContent = probe.error;
    connectStatus.classList.add('error');
    syncOverlayHeight();
    return false;
  }

  setStoredConnectionName(connectionNameInput.value);
  setStoredServerEndpoint(fields);
  sendToBackground('setServerUrl', { url: buildServerUrl(parsed.endpoint) });
  showMainApp();
  void refreshRelayStatus();
  connectStatus.textContent = 'Connected.';
  connectStatus.classList.add('ok');
  syncOverlayHeight();
  return true;
}

async function syncConnectionGate(): Promise<void> {
  if (!isServerUrlConfigured()) {
    showConnectGate();
    syncOverlayHeight();
    return;
  }

  const fields = getStoredServerEndpointFields();
  applyServerEndpointFields(fields);
  applyConnectionNameField();
  connectStatus.className = 'connect-status';
  connectStatus.textContent = 'Checking server…';
  syncOverlayHeight();

  const probe = await probeSignalingServer(fields);
  if (probe.ok) {
    const parsed = parseServerEndpoint(fields);
    if (parsed.ok) {
      sendToBackground('setServerUrl', { url: buildServerUrl(parsed.endpoint) });
    }
    showMainApp();
    connectStatus.textContent = '';
  } else {
    clearStoredServerUrl();
    showConnectGate();
    connectStatus.textContent = probe.error;
    connectStatus.classList.add('error');
  }
  syncOverlayHeight();
}

window.addEventListener('serverDisconnected', ((event: CustomEvent<{ reason?: string }>) => {
  clearStoredServerUrl();
  showConnectGate();
  const reason = event.detail?.reason;
  if (reason) {
    connectStatus.textContent = reason;
    connectStatus.classList.add('error');
  }
  syncOverlayHeight();
}) as EventListener);

async function submitConnect(): Promise<void> {
  const name = connectionNameInput.value;
  if (!normalizeConnectionName(name)) {
    connectStatus.className = 'connect-status error';
    connectStatus.textContent = 'Enter your name (1–24 characters).';
    connectionNameInput.focus();
    syncOverlayHeight();
    return;
  }

  const fields = readServerEndpointFields();
  const parsed = parseServerEndpoint(fields);
  if (!parsed.ok) {
    connectStatus.className = 'connect-status';
    connectStatus.textContent = parsed.error;
    connectStatus.classList.add('error');
    if (!fields.protocol) {
      serverProtocolSelect.focus();
    } else if (!fields.host.trim()) {
      serverHostInput.focus();
    } else {
      serverPortInput.focus();
    }
    return;
  }
  const ok = await connectToServer(fields);
  if (!ok && !connectStatus.classList.contains('error')) {
    serverHostInput.focus();
  }
}

btnConnectServer.addEventListener('click', () => void submitConnect());

for (const el of [connectionNameInput, serverProtocolSelect, serverHostInput, serverPortInput]) {
  el.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void submitConnect();
    }
  });
}

let scanningSinceMs: number | null = null;
let calibrating = false;

btnAlignScanner.addEventListener('click', () => {
  calibrating = true;
  btnAlignScanner.classList.add('hidden');
  btnCalibrateDone.classList.remove('hidden');
  invoke('begin_scanner_calibration').catch((e) => console.warn('[Overlay] calibration begin:', e));
  void emit('calibration:begin');
});

btnCalibrateDone.addEventListener('click', () => {
  calibrating = false;
  btnCalibrateDone.classList.add('hidden');
  btnAlignScanner.classList.remove('hidden');
  invoke('end_scanner_calibration').catch((e) => console.warn('[Overlay] calibration end:', e));
  void emit('calibration:end');
});

listen<{ screen_x: number; screen_y: number; screen_width: number; screen_height: number }>(
  'calibration:bounds',
  (event) => {
    const b = event.payload;
    sendToBackground('calibrationBounds', {
      screenX: b.screen_x,
      screenY: b.screen_y,
      screenWidth: b.screen_width,
      screenHeight: b.screen_height,
    });
  },
).catch((e) => console.warn('[Overlay] calibration:bounds listen failed:', e));

const btnOpenLogs = IS_DEV_BUILD ? document.getElementById('btn-open-logs') as HTMLButtonElement : null;
if (btnOpenLogs) {
  btnOpenLogs.addEventListener('click', () => {
    sendToBackground('openLogFolder', {});
  });
}

// v0.3 (#1): PTT key rebind.
const PTT_VK_KEY = 'lolproxchat.pttVk';
const DEFAULT_PTT_VK: number | null = null;
const FORBIDDEN_CODES = new Set([
  'Escape', 'Tab',
  // Common LoL bindings — would conflict with gameplay even though our
  // hook fires first.
  'KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyD', 'KeyF', 'KeyB', 'KeyP',
  // Modifier-only is bad UX (always pressed during typing combos)
  'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight',
  'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight',
]);

function setupBindButton(buttonId: string, storageKey: string, backgroundCmd: string, defaultVk: number | null): void {
  const btn = document.getElementById(buttonId) as HTMLButtonElement;
  if (!btn) return;
  const stored = localStorage.getItem(storageKey);
  const initialVk = stored !== null ? parseInt(stored, 10) : defaultVk;
  if (initialVk !== null && !Number.isNaN(initialVk) && initialVk > 0) {
    btn.textContent = humanizeVk(initialVk);
  } else {
    btn.textContent = '(unbound)';
  }

  btn.addEventListener('click', () => {
    const originalText = btn.textContent || '(unbound)';
    btn.textContent = 'Press a key…';
    btn.classList.add('active');
    btn.disabled = true;
    const restore = (text: string) => {
      btn.textContent = text;
      btn.classList.remove('active');
      btn.disabled = false;
    };
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      window.removeEventListener('keydown', onKey, true);
      if (e.code === 'Escape') {
        restore(originalText);
        return;
      }
      if (e.code === 'Backspace' || e.code === 'Delete') {
        localStorage.removeItem(storageKey);
        sendToBackground(backgroundCmd, { vk: 0 });
        restore('(unbound)');
        return;
      }
      if (FORBIDDEN_CODES.has(e.code)) {
        restore('(LoL/system key — pick another)');
        setTimeout(() => restore(originalText), 1500);
        return;
      }
      const vk = browserKeyToWin32Vk(e.code);
      if (vk === null) {
        restore('(key not supported)');
        setTimeout(() => restore(originalText), 1500);
        return;
      }
      localStorage.setItem(storageKey, String(vk));
      sendToBackground(backgroundCmd, { vk });
      restore(humanizeVk(vk));
    };
    window.addEventListener('keydown', onKey, true);
  });
}

queueMicrotask(() => {
  setupBindButton('btn-bind-ptt', PTT_VK_KEY, 'setPttKey', DEFAULT_PTT_VK);
  const ptt = localStorage.getItem(PTT_VK_KEY);
  const vk = ptt !== null ? parseInt(ptt, 10) : 0;
  sendToBackground('setPttKey', { vk: !Number.isNaN(vk) && vk > 0 ? vk : 0 });
});

// WH_KEYBOARD_LL does not always reach our hook when this webview has focus.
// Mirror PTT here so IDLE→LIVE works while clicking around the overlay.
let localPttDown = false;

function readBoundPttVk(): number {
  const stored = localStorage.getItem(PTT_VK_KEY);
  if (stored === null) return 0;
  const vk = parseInt(stored, 10);
  return !Number.isNaN(vk) && vk > 0 ? vk : 0;
}

function isTextInputTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return target.isContentEditable;
}

function handleOverlayPttKeydown(e: KeyboardEvent): void {
  if (isTextInputTarget(e.target)) return;
  const boundVk = readBoundPttVk();
  if (!boundVk) return;
  const vk = browserKeyToWin32Vk(e.code);
  if (vk === null || vk !== boundVk) return;
  if (e.repeat) return;
  e.preventDefault();
  if (!localPttDown) {
    localPttDown = true;
    sendToBackground('resumeAudio', {});
    sendToBackground('setPTT', { held: true });
  }
}

function handleOverlayPttKeyup(e: KeyboardEvent): void {
  if (isTextInputTarget(e.target)) return;
  const boundVk = readBoundPttVk();
  if (!boundVk) return;
  const vk = browserKeyToWin32Vk(e.code);
  if (vk === null || vk !== boundVk) return;
  e.preventDefault();
  if (localPttDown) {
    localPttDown = false;
    sendToBackground('setPTT', { held: false });
  }
}

window.addEventListener('keydown', handleOverlayPttKeydown, true);
window.addEventListener('keyup', handleOverlayPttKeyup, true);
window.addEventListener('blur', () => {
  if (localPttDown) {
    localPttDown = false;
    sendToBackground('setPTT', { held: false });
  }
});

if (btnDebug) {
  btnDebug.addEventListener('click', () => {
    debugEnabled = !debugEnabled;
    btnDebug.textContent = debugEnabled ? 'ON' : 'OFF';
    btnDebug.classList.toggle('active', debugEnabled);
    scanRateRow?.classList.toggle('hidden', !debugEnabled);
    setLoggingEnabled(debugEnabled);
    window.__lolproxchat_debug_enabled = debugEnabled;
    if (!debugEnabled) {
      debugFilterThumb?.classList.add('hidden');
      debugFilterThumb?.removeAttribute('src');
    }
    syncOverlayHeight();
  });
}

const debugFilterThumb = IS_DEV_BUILD
  ? document.getElementById('debug-filter-thumb') as HTMLImageElement
  : null;
if (IS_DEV_BUILD && debugFilterThumb) {
  listen<{ filteredImageUrl: string | null; debugEnabled: boolean }>('scanner:scene', (event) => {
    const { filteredImageUrl, debugEnabled: dbg } = event.payload;
    if (dbg && filteredImageUrl) {
      debugFilterThumb.src = filteredImageUrl;
      debugFilterThumb.classList.remove('hidden');
    } else {
      debugFilterThumb.classList.add('hidden');
      if (!filteredImageUrl) debugFilterThumb.removeAttribute('src');
    }
  }).catch((e) => console.warn('[Overlay] scanner:scene listen failed:', e));

  debugFilterThumb.addEventListener('load', syncOverlayHeight);
}
const panelEl = document.querySelector('.panel');
if (panelEl) {
  new ResizeObserver(syncOverlayHeight).observe(panelEl);
}
window.addEventListener('DOMContentLoaded', () => {
  void syncConnectionGate();
});

document.querySelectorAll('.settings-category').forEach((el) => {
  el.addEventListener('toggle', syncOverlayHeight);
});

document.getElementById('input-mode')!.addEventListener('change', (e) => {
  const mode = (e.target as HTMLSelectElement).value;
  saveAudioSettings({ inputMode: mode as InputMode });
  sendToBackground('updateSettings', { inputMode: mode });
  if (shouldRunMicMonitor(mode)) {
    sendToBackground('ensureMicMonitor', {});
  }
  syncInputModePanels();
});

function shouldRunMicMonitor(mode: string): boolean {
  return mode === 'vad' || mode === 'ptt';
}

const vadSettings = document.getElementById('vad-settings')!;
const pttSettings = document.getElementById('ptt-settings')!;
const vadSensitivityInput = document.getElementById('vad-sensitivity') as HTMLInputElement;
const vadSensitivityLabel = document.getElementById('vad-sensitivity-label')!;
const vadHangoverInput = document.getElementById('vad-hangover') as HTMLInputElement;
const vadHangoverLabel = document.getElementById('vad-hangover-label')!;
const vadEngineSelect = IS_DEV_BUILD
  ? document.getElementById('vad-engine') as HTMLSelectElement
  : null;
const micMeterFill = document.getElementById('mic-meter-fill')!;
const noiseModeSelect = document.getElementById('noise-mode') as HTMLSelectElement;
const opusQualitySelect = document.getElementById('opus-quality') as HTMLSelectElement;
const btnEchoCancel = document.getElementById('btn-echo-cancel') as HTMLButtonElement;
const btnAutoGain = document.getElementById('btn-auto-gain') as HTMLButtonElement;
const btnBrowserNs = document.getElementById('btn-browser-ns') as HTMLButtonElement;
const volumeInput = document.getElementById('input-volume') as HTMLInputElement;
const volumeLabel = document.getElementById('volume-label')!;

function syncInputModePanels(): void {
  const mode = (document.getElementById('input-mode') as HTMLSelectElement).value;
  vadSettings.classList.toggle('hidden', mode !== 'vad');
  pttSettings.classList.toggle('hidden', mode !== 'ptt');
  syncOverlayHeight();
}

function syncToggleBtn(btn: HTMLButtonElement, on: boolean): void {
  btn.textContent = on ? 'ON' : 'OFF';
  btn.classList.toggle('active', on);
}

function loadPersistedAudioSettings(): void {
  const s = loadAudioSettings();
  const inputMode = document.getElementById('input-mode') as HTMLSelectElement;
  if (s.inputMode) inputMode.value = s.inputMode;
  if (s.inputVolume !== undefined) {
    volumeInput.value = String(Math.round(s.inputVolume * 100));
    volumeLabel.textContent = String(Math.round(s.inputVolume * 100));
  }
  if (s.vadSensitivity !== undefined) {
    vadSensitivityInput.value = String(s.vadSensitivity);
    vadSensitivityLabel.textContent = String(s.vadSensitivity);
  }
  if (s.vadHangoverMs !== undefined) {
    vadHangoverInput.value = String(s.vadHangoverMs);
    vadHangoverLabel.textContent = s.vadHangoverMs + 'ms';
  }
  if (s.vadEngine && vadEngineSelect) vadEngineSelect.value = s.vadEngine;
  if (s.noiseMode) noiseModeSelect.value = s.noiseMode;
  if (s.opusQuality) opusQualitySelect.value = s.opusQuality;
  syncToggleBtn(btnEchoCancel, s.echoCancellation !== false);
  syncToggleBtn(btnAutoGain, s.autoGainControl !== false);
  syncToggleBtn(btnBrowserNs, s.noiseSuppression !== false);
  if (s.playerVolumes) {
    for (const [name, vol] of Object.entries(s.playerVolumes)) {
      playerVolumes.set(name, vol);
    }
  }
  syncInputModePanels();
}

queueMicrotask(() => {
  if (!IS_DEV_BUILD && loadAudioSettings().vadEngine === 'silero') {
    saveAudioSettings({ vadEngine: 'energy' });
    sendToBackground('updateSettings', { vadEngine: 'energy' });
  }
  loadPersistedAudioSettings();
  // Mic monitor starts on settings open / panel click (needs user gesture for Web Audio).
});

vadSensitivityInput.addEventListener('input', () => {
  const raw = parseInt(vadSensitivityInput.value, 10);
  vadSensitivityLabel.textContent = String(raw);
  saveAudioSettings({ vadSensitivity: raw });
  sendToBackground('updateSettings', { vadSensitivity: raw });
});

vadHangoverInput.addEventListener('input', () => {
  const raw = parseInt(vadHangoverInput.value, 10);
  vadHangoverLabel.textContent = raw + 'ms';
  saveAudioSettings({ vadHangoverMs: raw });
  sendToBackground('updateSettings', { vadHangoverMs: raw });
});

if (vadEngineSelect) {
  vadEngineSelect.addEventListener('change', () => {
    const engine = vadEngineSelect.value as 'energy' | 'silero';
    saveAudioSettings({ vadEngine: engine });
    sendToBackground('updateSettings', { vadEngine: engine });
  });
}

noiseModeSelect.addEventListener('change', () => {
  const mode = noiseModeSelect.value as 'native' | 'rnnoise';
  saveAudioSettings({ noiseMode: mode });
  sendToBackground('updateSettings', { noiseMode: mode });
});

opusQualitySelect.addEventListener('change', () => {
  const q = opusQualitySelect.value as 'voice' | 'standard' | 'high';
  saveAudioSettings({ opusQuality: q });
  sendToBackground('updateSettings', { opusQuality: q });
});

btnEchoCancel.addEventListener('click', () => {
  const on = !btnEchoCancel.classList.contains('active');
  syncToggleBtn(btnEchoCancel, on);
  saveAudioSettings({ echoCancellation: on });
  sendToBackground('updateSettings', { echoCancellation: on });
});

btnAutoGain.addEventListener('click', () => {
  const on = !btnAutoGain.classList.contains('active');
  syncToggleBtn(btnAutoGain, on);
  saveAudioSettings({ autoGainControl: on });
  sendToBackground('updateSettings', { autoGainControl: on });
});

btnBrowserNs.addEventListener('click', () => {
  const on = !btnBrowserNs.classList.contains('active');
  syncToggleBtn(btnBrowserNs, on);
  saveAudioSettings({ noiseSuppression: on });
  sendToBackground('updateSettings', { noiseSuppression: on });
});

volumeInput.addEventListener('input', () => {
  const raw = parseInt(volumeInput.value);
  volumeLabel.textContent = String(raw);
  const vol = raw / 100;
  saveAudioSettings({ inputVolume: vol });
  sendToBackground('updateSettings', { inputVolume: vol });
});

const scanRateInput = IS_DEV_BUILD
  ? document.getElementById('input-scan-rate') as HTMLInputElement
  : null;
const scanRateLabel = IS_DEV_BUILD
  ? document.getElementById('scan-rate-label')!
  : null;
if (scanRateInput && scanRateLabel) {
  scanRateInput.addEventListener('input', () => {
    const raw = parseInt(scanRateInput.value);
    scanRateLabel.textContent = String(raw);
    const fps = Math.max(1, Math.round(1 + (raw / 100) * 59));
    sendToBackground('setScanRate', { fps });
  });
}

function sendToBackground(action: string, payload: any): void {
  // In Tauri, both background and overlay run in the same WebView,
  // so we use window events for communication
  window.dispatchEvent(new CustomEvent('overlayAction', { detail: { action, payload } }));
}

// Report the panel's current size to Rust so the click-through hit-test
// follows collapse/expand/settings open. Multiply by devicePixelRatio
// because offsetWidth/Height are CSS pixels but the Rust side compares
// against physical-pixel cursor coords from GetCursorPos.
const reportPanelSize = () => {
  const dpr = window.devicePixelRatio || 1;
  sendToBackground('panelResize', {
    width: Math.round(panel.offsetWidth * dpr),
    height: Math.round(panel.offsetHeight * dpr),
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
  speakingDot: HTMLElement;
}> = new Map();

// Track whether a player slider is being actively dragged
let activeSliderPlayer: string | null = null;

function createPlayerRow(peer: NearbyPeer, localTeam: 'ORDER' | 'CHAOS' | null | undefined): HTMLElement {
  const row = document.createElement('div');
  const isAlly = localTeam ? peer.team === localTeam : peer.team === 'ORDER';
  row.className = 'player-row ' + (isAlly ? 'ally' : 'enemy');
  if (peer.isSpeaking) row.classList.add('speaking');

  const speakingDot = document.createElement('span');
  speakingDot.className = 'player-speaking-dot';
  row.appendChild(speakingDot);

  const nameSpan = document.createElement('span');
  nameSpan.className = 'player-name';
  nameSpan.textContent = peer.championName;
  nameSpan.title = peer.summonerName;
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
    saveAudioSettings({ playerVolumes: Object.fromEntries(playerVolumes) });
    sendToBackground('setPlayerVolume', { name: peer.summonerName, volume: vol });
  });
  row.appendChild(volSlider);

  const muteBtn = document.createElement('button') as HTMLButtonElement;
  muteBtn.className = 'player-mute-btn' + (peer.isMutedByLocal ? ' muted' : '');
  muteBtn.textContent = peer.isMutedByLocal ? 'MUTED' : 'MUTE';
  muteBtn.addEventListener('click', () => {
    // Flip the UI immediately so the user gets feedback without waiting
    // for the next broadcastOverlayState tick. Backend state will confirm.
    const nowMuted = !muteBtn.classList.contains('muted');
    muteBtn.classList.toggle('muted', nowMuted);
    muteBtn.textContent = nowMuted ? 'MUTED' : 'MUTE';
    console.log('[Overlay] Mute toggled for', peer.summonerName, '→', nowMuted);
    sendToBackground('toggleMutePlayer', { name: peer.summonerName });
  });
  row.appendChild(muteBtn);

  playerRows.set(peer.summonerName, { row, nameSpan, indicator, volSlider, muteBtn, speakingDot });
  return row;
}

function updatePlayerRow(peer: NearbyPeer): void {
  const entry = playerRows.get(peer.summonerName);
  if (!entry) return;

  entry.row.classList.toggle('speaking', !!peer.isSpeaking);
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

function updateTransmitStatus(state: OverlayState): void {
  transmitStatus.classList.remove('live', 'muted', 'standby');
  if (state.selfMuted) {
    transmitStatus.classList.add('muted');
    transmitLabel.textContent = 'MUTED';
    return;
  }
  if (state.micTransmitting) {
    transmitStatus.classList.add('live');
    transmitLabel.textContent = 'LIVE';
    return;
  }
  transmitStatus.classList.add('standby');
  transmitLabel.textContent = 'IDLE';
}

// --- Render state ---
function renderState(state: OverlayState): void {
  updateTransmitStatus(state);

  if (state.micLevel !== undefined && micMeterFill) {
    const pct = Math.round(Math.min(1, state.micLevel) * 100);
    micMeterFill.style.width = pct + '%';
    micMeterFill.classList.toggle('transmitting', !!state.micTransmitting);
  }

  // Sort: allies first, then by champion name
  const localTeam = state.localTeam ?? null;
  const sortedPeers = [...state.nearbyPeers].sort((a, b) => {
    if (localTeam) {
      const aAlly = a.team === localTeam;
      const bAlly = b.team === localTeam;
      if (aAlly !== bAlly) return aAlly ? -1 : 1;
    }
    return a.championName.localeCompare(b.championName);
  });

  // Build set of current peer names for diffing
  const currentNames = new Set(sortedPeers.map(p => p.summonerName));

  // Remove rows for peers that left
  for (const [name, entry] of playerRows) {
    if (!currentNames.has(name)) {
      entry.row.remove();
      playerRows.delete(name);
    }
  }

  // Update existing rows or create new ones, in sorted order.
  // Only reorder DOM when the sort order *actually* changed — re-appending
  // a slider mid-drag detaches it from its pointer-event sequence, which
  // is why the per-player volume slider felt "clicky" / had to be re-grabbed
  // at every tick (issue #12). At 10 Hz position ticks the order rarely
  // changes, so the common case is now a no-op.
  const desiredOrder = sortedPeers.map(p => p.summonerName);
  const currentOrder: string[] = [];
  for (const child of Array.from(playerList.children)) {
    for (const [name, entry] of playerRows) {
      if (entry.row === child) { currentOrder.push(name); break; }
    }
  }
  const orderChanged = currentOrder.length !== desiredOrder.length
    || currentOrder.some((n, i) => n !== desiredOrder[i]);

  for (const peer of sortedPeers) {
    let entry = playerRows.get(peer.summonerName);
    if (entry) {
      updatePlayerRow(peer);
    } else {
      const row = createPlayerRow(peer, localTeam);
      playerList.appendChild(row);
      entry = playerRows.get(peer.summonerName);
    }
    if (orderChanged && entry && entry.row.parentElement === playerList) {
      playerList.appendChild(entry.row);
    }
  }

  // Show/hide empty state with lifecycle-aware text
  const emptyText = state.lifecycleStatus || 'Waiting for nearby players...';
  const emptyState = playerList.querySelector('.empty-state');
  if (sortedPeers.length === 0) {
    if (!emptyState) {
      const emptyDiv = document.createElement('div');
      emptyDiv.className = 'empty-state';
      emptyDiv.textContent = emptyText;
      playerList.appendChild(emptyDiv);
    } else if (emptyState.textContent !== emptyText) {
      emptyState.textContent = emptyText;
    }
  } else if (emptyState) {
    emptyState.remove();
  }

  // Show align-scanner after 15s in scanning state
  if (state.trackingState === 'scanning' && !calibrating) {
    if (scanningSinceMs === null) scanningSinceMs = performance.now();
    const elapsed = performance.now() - scanningSinceMs;
    calibrateRow.classList.toggle('hidden', elapsed < 15000);
  } else {
    scanningSinceMs = null;
    if (!calibrating) calibrateRow.classList.add('hidden');
  }

  // Debug info (dev builds only)
  if (IS_DEV_BUILD && debugEnabled) {
    const dbgEl = document.getElementById('debug-info');
    if (dbgEl && (state.trackingState || state.lastPosition)) {
      const parts: string[] = [];
      if (state.trackingState) parts.push('tracking: ' + state.trackingState);
      if (state.lastPosition) {
        parts.push('pos: (' + Math.round(state.lastPosition.x) + ',' + Math.round(state.lastPosition.y) + ')');
      }
      dbgEl.textContent = parts.join(' | ');
      dbgEl.classList.remove('hidden');
    } else if (dbgEl) {
      dbgEl.classList.add('hidden');
    }
  }
}

// --- Listen for state updates from background ---
window.addEventListener('overlayUpdate', ((event: CustomEvent) => {
  renderState(event.detail);
}) as EventListener);

window.addEventListener('sessionEnded', () => {
  const mode = (document.getElementById('input-mode') as HTMLSelectElement | null)?.value;
  if (mode && shouldRunMicMonitor(mode)) {
    sendToBackground('ensureMicMonitor', {});
  }
});

console.log('LoLProxChat overlay loaded');

export {};
