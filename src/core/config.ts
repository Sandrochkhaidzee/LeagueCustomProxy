import { getStoredServerEndpoint } from './server-prefs';
import {
  buildServerUrl,
  buildWsUrl,
  parseServerEndpoint,
  parseServerUrlToFields,
  type ServerEndpointFields,
} from './server-endpoint';

export {
  isServerUrlConfigured,
  getStoredServerUrl,
  getStoredServerEndpoint,
  getStoredServerEndpointFields,
  getStoredConnectionName,
  setStoredConnectionName,
  isConnectionNameConfigured,
  normalizeConnectionName,
  setStoredServerUrl,
  setStoredServerEndpoint,
  clearStoredServerUrl,
  normalizeServerUrl,
} from './server-prefs';

export { buildServerUrl, buildWsUrl, parseServerEndpoint } from './server-endpoint';
export type { ServerEndpoint, ServerEndpointFields } from './server-endpoint';

export function getServerUrl(): string | null {
  const endpoint = getStoredServerEndpoint();
  return endpoint ? buildServerUrl(endpoint) : null;
}

export function getWsUrl(): string | null {
  const endpoint = getStoredServerEndpoint();
  return endpoint ? buildWsUrl(endpoint) : null;
}

// Default STUN-only ICE servers (fallback if TURN credentials unavailable)
export const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
];

export type RelayStatus = 'turn' | 'stun-only' | 'unknown';

let cachedRelayStatus: RelayStatus | null = null;
let relayProbePromise: Promise<RelayStatus> | null = null;

function iceServersHaveTurn(servers: RTCIceServer[]): boolean {
  for (const s of servers) {
    const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
    for (const u of urls) {
      if (typeof u === 'string' && (u.startsWith('turn:') || u.startsWith('turns:'))) {
        return true;
      }
    }
  }
  return false;
}

/** Probe /turn-credentials once per session for settings UI. */
export async function probeRelayStatus(force = false): Promise<RelayStatus> {
  if (!getServerUrl()) return 'unknown';
  if (!force && cachedRelayStatus !== null) return cachedRelayStatus;
  if (!force && relayProbePromise) return relayProbePromise;
  relayProbePromise = (async () => {
    try {
      const servers = await getIceServers();
      cachedRelayStatus = iceServersHaveTurn(servers) ? 'turn' : 'stun-only';
    } catch {
      cachedRelayStatus = 'unknown';
    }
    return cachedRelayStatus;
  })();
  return relayProbePromise;
}

export function invalidateRelayCache(): void {
  cachedRelayStatus = null;
  relayProbePromise = null;
}

export type ServerProbeResult = { ok: true } | { ok: false; error: string };

const SERVER_PROBE_TIMEOUT_MS = 8000;

/** Verify the host signaling server is reachable before saving connection settings. */
export async function probeSignalingServer(
  endpointOrUrl: ServerEndpointFields | string,
): Promise<ServerProbeResult> {
  let base: string | null;
  if (typeof endpointOrUrl === 'string') {
    const fields = parseServerUrlToFields(endpointOrUrl);
    if (!fields) {
      return { ok: false, error: 'Enter protocol, host IP, and port.' };
    }
    const parsed = parseServerEndpoint(fields);
    if (!parsed.ok) {
      return { ok: false, error: parsed.error };
    }
    base = buildServerUrl(parsed.endpoint);
  } else {
    const parsed = parseServerEndpoint(endpointOrUrl);
    if (!parsed.ok) {
      return { ok: false, error: parsed.error };
    }
    base = buildServerUrl(parsed.endpoint);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SERVER_PROBE_TIMEOUT_MS);
  try {
    const resp = await fetch(`${base}/health`, { signal: controller.signal });
    if (!resp.ok) {
      return { ok: false, error: `Server returned HTTP ${resp.status}.` };
    }
    const data = await resp.json().catch(() => null) as { status?: string } | null;
    if (data?.status !== 'ok') {
      return { ok: false, error: 'URL responded but is not a LeagueProxy signaling server.' };
    }
    return { ok: true };
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      return { ok: false, error: 'Connection timed out — is the host running server.exe?' };
    }
    return { ok: false, error: 'Cannot reach server — check protocol, host, port, and firewall.' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch ICE servers with TURN credentials from the signaling server.
 * TURN secret never touches the client — HMAC generation happens server-side.
 */
export async function getIceServers(): Promise<RTCIceServer[]> {
  const base = getServerUrl();
  if (!base) return ICE_SERVERS;
  try {
    const resp = await fetch(`${base}/turn-credentials`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    if (data.iceServers && data.iceServers.length > 0) {
      return data.iceServers;
    }
  } catch (e) {
    console.warn('[Config] Failed to fetch TURN credentials, using STUN only:', e);
  }
  return ICE_SERVERS;
}
