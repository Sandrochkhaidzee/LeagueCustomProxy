import { invoke } from '@tauri-apps/api/core';
import {
  checkForUpdate,
  downloadAndApply,
  formatInvokeError,
} from '../services/updater';
import { computeDesiredHeight } from '../overlay/resize-helpers';
import {
  buildServerUrl,
  parseServerEndpoint,
  type ServerEndpointFields,
} from '../core/server-endpoint';
import {
  getStoredHostEndpointFields,
  readHostPort,
  setStoredHostEndpoint,
} from '../core/host-prefs';
import {
  fetchHostClients,
  fetchHostLogs,
  formatClientLabel,
  formatLogLine,
  kickHostClient,
  type HostAdminClient,
  type HostAdminLog,
} from '../services/host-admin';
import '../core/window-globals';

let resizeQueued = false;
function syncOverlayHeight(): void {
  if (resizeQueued) return;
  resizeQueued = true;
  requestAnimationFrame(() => {
    resizeQueued = false;
    const panel = document.querySelector('.panel') as HTMLElement | null;
    if (!panel) return;
    const dpr = window.devicePixelRatio || 1;
    const desired = computeDesiredHeight(Math.ceil(panel.scrollHeight));
    sendToBackground('resizeOverlay', { height: Math.round(desired * dpr) });
  });
}

const btnCollapse = document.getElementById('btn-collapse')!;
const btnClose = document.getElementById('btn-close')!;
const panel = document.getElementById('panel')!;
const collapseChevron = document.getElementById('collapse-chevron')!;
const hostBadge = document.getElementById('host-badge')!;
const hostLabel = document.getElementById('host-label')!;
const btnHostStart = document.getElementById('btn-host-start') as HTMLButtonElement;
const btnHostStop = document.getElementById('btn-host-stop') as HTMLButtonElement;
const btnCopyHostUrl = document.getElementById('btn-copy-host-url') as HTMLButtonElement;
const hostProtocolSelect = document.getElementById('host-protocol') as HTMLSelectElement;
const hostIpInput = document.getElementById('host-ip') as HTMLInputElement;
const hostPortInput = document.getElementById('host-port') as HTMLInputElement;
const hostStatusEl = document.getElementById('host-status')!;
const hostLogEl = document.getElementById('host-log')!;
const hostClientsEl = document.getElementById('host-clients')!;
const btnClearLog = document.getElementById('btn-clear-log') as HTMLButtonElement;
const connectionsSection = document.getElementById('connections-section')!;
const btnCheckUpdate = document.getElementById('btn-check-update') as HTMLButtonElement;
const updateStatus = document.getElementById('update-status')!;

const PANEL_COLLAPSED_KEY = 'lolproxchat.server.panelCollapsed';

let lastLogId = 0;
const logLines: string[] = [];
const MAX_LOG_LINES = 200;
let adminPollRunning = false;
let adminLocalPort = 0;

function appendLogEntries(entries: HostAdminLog[]): void {
  if (entries.length === 0) return;
  for (const entry of entries) {
    logLines.push(formatLogLine(entry));
    lastLogId = Math.max(lastLogId, entry.id);
  }
  while (logLines.length > MAX_LOG_LINES) {
    logLines.shift();
  }
  hostLogEl.textContent = logLines.join('\n');
  hostLogEl.scrollTop = hostLogEl.scrollHeight;
  syncOverlayHeight();
}

function renderClientList(clients: HostAdminClient[]): void {
  hostClientsEl.replaceChildren();
  for (const client of clients) {
    const row = document.createElement('div');
    row.className = 'host-client-row';

    const meta = document.createElement('div');
    meta.className = 'host-client-meta';
    const title = document.createElement('div');
    title.textContent = formatClientLabel(client);
    meta.append(title);

    const kickBtn = document.createElement('button');
    kickBtn.type = 'button';
    kickBtn.className = 'icon-btn';
    kickBtn.textContent = 'Kick';
    kickBtn.title = 'Disconnect this client';
    kickBtn.addEventListener('click', () => {
      kickBtn.disabled = true;
      void kickHostClient(adminLocalPort, client.clientId)
        .then(() => refreshAdminPanel())
        .catch((e) => { hostStatusEl.textContent = formatInvokeError(e); })
        .finally(() => { kickBtn.disabled = false; });
    });

    row.append(meta, kickBtn);
    hostClientsEl.appendChild(row);
  }
  syncOverlayHeight();
}

async function refreshAdminPanel(): Promise<void> {
  if (!adminLocalPort || adminPollRunning) return;
  adminPollRunning = true;
  try {
    const [clients, logs] = await Promise.all([
      fetchHostClients(adminLocalPort),
      fetchHostLogs(adminLocalPort, lastLogId),
    ]);
    appendLogEntries(logs);
    renderClientList(clients);
  } catch (e) {
    const msg = formatInvokeError(e);
    hostLogEl.textContent = `Admin panel unavailable: ${msg}`;
    if (msg.includes('not running') || msg.includes('already in use') || msg.includes('did not start')) {
      void refreshHostStatus();
    }
  } finally {
    adminPollRunning = false;
  }
}

function resetAdminPanel(): void {
  adminLocalPort = 0;
  lastLogId = 0;
  logLines.length = 0;
  hostLogEl.textContent = '';
  hostClientsEl.replaceChildren();
  connectionsSection.classList.add('hidden');
  syncOverlayHeight();
}

function startAdminPanel(port: number): void {
  adminLocalPort = port;
  lastLogId = 0;
  logLines.length = 0;
  hostLogEl.textContent = '';
  hostClientsEl.replaceChildren();
  connectionsSection.classList.remove('hidden');
  void refreshAdminPanel();
  syncOverlayHeight();
}

btnClearLog.addEventListener('click', () => {
  logLines.length = 0;
  hostLogEl.textContent = '';
  syncOverlayHeight();
});

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
  setPanelCollapsed(!isPanelCollapsed());
});

btnClose.addEventListener('click', (e) => {
  e.preventDefault();
  e.stopPropagation();
  void (async () => {
    try {
      await invoke('stop_signaling_server');
    } catch {
      // still exit if stop fails
    }
    await invoke('exit_app');
  })().catch(() => window.close());
});

interface HostServerStatus {
  running: boolean;
  error: string | null;
  port: number;
}

function readHostEndpointFields(): ServerEndpointFields {
  return {
    protocol: hostProtocolSelect.value,
    host: hostIpInput.value,
    port: hostPortInput.value,
  };
}

function applyHostEndpointFields(fields: ServerEndpointFields): void {
  hostProtocolSelect.value = fields.protocol;
  hostIpInput.value = fields.host;
  hostPortInput.value = fields.port;
}

function setHostFieldsEnabled(enabled: boolean): void {
  hostProtocolSelect.disabled = !enabled;
  hostIpInput.disabled = !enabled;
  hostPortInput.disabled = !enabled;
}

function validateHostEndpointFields(): ReturnType<typeof parseServerEndpoint> {
  return parseServerEndpoint(readHostEndpointFields());
}

async function persistHostEndpointFields(): Promise<void> {
  const fields = readHostEndpointFields();
  const parsed = parseServerEndpoint(fields);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  setStoredHostEndpoint(fields);
  await invoke('set_signaling_port', { port: parsed.endpoint.port });
}

function setHostStatusStopped(port: number | null): void {
  if (port) {
    hostStatusEl.textContent =
      `Stopped — needs Node.js 24+ installed. Allow TCP ${port} through firewall.`;
  } else {
    hostStatusEl.textContent = 'Stopped — enter host address and port, then Start server.';
  }
}

async function refreshHostStatus(): Promise<void> {
  try {
    const st = await invoke<HostServerStatus>('signaling_server_status');
    btnHostStart.classList.toggle('hidden', st.running);
    btnHostStop.classList.toggle('hidden', !st.running);
    setHostBadge(st.running);
    setHostFieldsEnabled(!st.running);
    if (st.port > 0) {
      hostPortInput.value = String(st.port);
    }
    if (st.running) {
      hostStatusEl.textContent =
        `Running on :${st.port} — share URL with friends.`;
      if (adminLocalPort !== st.port) {
        startAdminPanel(st.port);
      }
    } else {
      if (adminLocalPort) {
        resetAdminPanel();
      }
      if (st.error) {
        hostStatusEl.textContent = st.error;
      } else {
        setHostStatusStopped(st.port > 0 ? st.port : readHostPort(readHostEndpointFields()));
      }
    }
  } catch (e) {
    hostStatusEl.textContent = 'Status error: ' + formatInvokeError(e);
    setHostBadge(false);
    setHostFieldsEnabled(true);
  }
}

const storedHostFields = getStoredHostEndpointFields();
if (storedHostFields.protocol || storedHostFields.host || storedHostFields.port) {
  applyHostEndpointFields(storedHostFields);
  const port = readHostPort(storedHostFields);
  if (port) {
    void invoke('set_signaling_port', { port }).catch((e) => {
      hostStatusEl.textContent = formatInvokeError(e);
    });
  }
}

for (const el of [hostProtocolSelect, hostIpInput, hostPortInput]) {
  el.addEventListener('change', () => {
    const parsed = validateHostEndpointFields();
    if (!parsed.ok) return;
    void persistHostEndpointFields()
      .then(() => refreshHostStatus())
      .catch((e) => { hostStatusEl.textContent = formatInvokeError(e); });
  });
}

function setHostBadge(running: boolean): void {
  hostLabel.textContent = running ? 'RUNNING' : 'STOPPED';
  hostBadge.classList.remove('live', 'standby');
  hostBadge.classList.add(running ? 'live' : 'standby');
}

btnHostStart.addEventListener('click', () => {
  const parsed = validateHostEndpointFields();
  if (!parsed.ok) {
    hostStatusEl.textContent = parsed.error;
    return;
  }
  btnHostStart.disabled = true;
  hostStatusEl.textContent = 'Starting…';
  void persistHostEndpointFields()
    .then(() => invoke('start_signaling_server', { port: parsed.endpoint.port }))
    .then(() => refreshHostStatus())
    .catch((e) => { hostStatusEl.textContent = formatInvokeError(e); })
    .finally(() => { btnHostStart.disabled = false; });
});

btnHostStop.addEventListener('click', () => {
  invoke('stop_signaling_server')
    .then(() => refreshHostStatus())
    .catch((e) => { hostStatusEl.textContent = formatInvokeError(e); });
});

btnCopyHostUrl.addEventListener('click', () => {
  const parsed = validateHostEndpointFields();
  if (!parsed.ok) {
    hostStatusEl.textContent = parsed.error;
    return;
  }
  const url = buildServerUrl(parsed.endpoint);
  navigator.clipboard.writeText(url)
    .then(() => { hostStatusEl.textContent = 'URL copied to clipboard.'; })
    .catch((e) => { hostStatusEl.textContent = 'Copy failed: ' + formatInvokeError(e); });
});

async function runUpdateCheck(): Promise<void> {
  updateStatus.textContent = 'Checking for updates…';
  try {
    const info = await checkForUpdate();
    if (info.update_available && info.download_url) {
      updateStatus.textContent = 'Update available: v' + info.latest_version + ' — applying…';
      await downloadAndApply(info.download_url);
    } else if (info.update_available && !info.download_url) {
      updateStatus.textContent = 'Update v' + info.latest_version
        + ' exists but no server.exe on the release';
    } else {
      updateStatus.textContent = 'Up to date (v' + info.current_version + ')';
    }
  } catch (e) {
    updateStatus.textContent = 'Update check failed: ' + formatInvokeError(e);
  }
}

btnCheckUpdate.addEventListener('click', () => void runUpdateCheck());

function sendToBackground(action: string, payload: unknown): void {
  window.dispatchEvent(new CustomEvent('overlayAction', { detail: { action, payload } }));
}

const panelResizeObserver = new ResizeObserver(() => {
  const rect = panel.getBoundingClientRect();
  sendToBackground('panelResize', {
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  });
  syncOverlayHeight();
});
panelResizeObserver.observe(panel);

void refreshHostStatus();
setInterval(() => void refreshHostStatus(), 5000);
setInterval(() => {
  if (adminLocalPort > 0) {
    void refreshAdminPanel();
  }
}, 2000);
syncOverlayHeight();
