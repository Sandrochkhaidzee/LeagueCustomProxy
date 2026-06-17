import {
  buildServerUrl,
  buildWsUrl,
  parseServerEndpoint,
  parseServerUrlToFields,
  type ServerEndpoint,
  type ServerEndpointFields,
} from './server-endpoint';

const PROTOCOL_KEY = 'lolproxchat.serverProtocol';
const HOST_KEY = 'lolproxchat.serverHost';
const PORT_KEY = 'lolproxchat.serverPort';
const CONNECTION_NAME_KEY = 'lolproxchat.connectionName';
const LEGACY_URL_KEY = 'lolproxchat.serverUrl';

function sessionStore(): Storage {
  return sessionStorage;
}

// Older builds persisted in localStorage; wipe so relaunch always prompts.
try {
  localStorage.removeItem(LEGACY_URL_KEY);
} catch { /* ignore */ }

function readFields(): ServerEndpointFields {
  const protocol = sessionStore().getItem(PROTOCOL_KEY) ?? '';
  const host = sessionStore().getItem(HOST_KEY) ?? '';
  const port = sessionStore().getItem(PORT_KEY) ?? '';
  if (!protocol && !host && !port) {
    const legacy = sessionStore().getItem(LEGACY_URL_KEY);
    if (legacy) {
      const migrated = parseServerUrlToFields(legacy);
      if (migrated) return migrated;
    }
  }
  return { protocol, host, port };
}

export function normalizeConnectionName(raw: string): string | null {
  const name = raw.trim();
  if (!name || name.length > 24) return null;
  return name;
}

export function getStoredConnectionName(): string {
  return sessionStore().getItem(CONNECTION_NAME_KEY)?.trim() ?? '';
}

export function setStoredConnectionName(raw: string): void {
  const name = normalizeConnectionName(raw);
  if (!name) {
    throw new Error('Enter your name (1–24 characters).');
  }
  sessionStore().setItem(CONNECTION_NAME_KEY, name);
}

export function isConnectionNameConfigured(): boolean {
  return !!normalizeConnectionName(getStoredConnectionName());
}

export function getStoredServerEndpointFields(): ServerEndpointFields {
  return readFields();
}

export function isServerUrlConfigured(): boolean {
  return parseServerEndpoint(readFields()).ok && isConnectionNameConfigured();
}

export function getStoredServerEndpoint(): ServerEndpoint | null {
  const parsed = parseServerEndpoint(readFields());
  return parsed.ok ? parsed.endpoint : null;
}

export function getStoredServerUrl(): string | null {
  const endpoint = getStoredServerEndpoint();
  return endpoint ? buildServerUrl(endpoint) : null;
}

export function setStoredServerEndpoint(fields: ServerEndpointFields): void {
  const parsed = parseServerEndpoint(fields);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  const { protocol, host, port } = parsed.endpoint;
  sessionStore().setItem(PROTOCOL_KEY, protocol);
  sessionStore().setItem(HOST_KEY, host);
  sessionStore().setItem(PORT_KEY, String(port));
  sessionStore().removeItem(LEGACY_URL_KEY);
}

export function setStoredServerUrl(url: string): void {
  const fields = parseServerUrlToFields(url);
  if (!fields) {
    throw new Error('Invalid server URL');
  }
  setStoredServerEndpoint(fields);
}

export function clearStoredServerUrl(): void {
  sessionStore().removeItem(PROTOCOL_KEY);
  sessionStore().removeItem(HOST_KEY);
  sessionStore().removeItem(PORT_KEY);
  sessionStore().removeItem(CONNECTION_NAME_KEY);
  sessionStore().removeItem(LEGACY_URL_KEY);
}

/** @deprecated Use parseServerEndpoint — kept for callers passing a full URL string. */
export function normalizeServerUrl(raw: string): string | null {
  const fields = parseServerUrlToFields(raw);
  if (!fields) return null;
  const parsed = parseServerEndpoint(fields);
  return parsed.ok ? buildServerUrl(parsed.endpoint) : null;
}

export function getWsUrlFromServer(serverUrl: string): string {
  const fields = parseServerUrlToFields(serverUrl);
  if (!fields) {
    throw new Error('Invalid server URL');
  }
  const parsed = parseServerEndpoint(fields);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  return buildWsUrl(parsed.endpoint);
}
