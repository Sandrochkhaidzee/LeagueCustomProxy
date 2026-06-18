import {
  parseServerEndpoint,
  type ServerEndpoint,
  type ServerEndpointFields,
} from './server-endpoint';

export type HostMode = 'direct' | 'cloudflare';

const PROTOCOL_KEY = 'lolproxchat.hostProtocol';
const HOST_KEY = 'lolproxchat.hostIp';
const PORT_KEY = 'lolproxchat.hostPort';
const MODE_KEY = 'lolproxchat.hostMode';
const CLOUDFLARED_PATH_KEY = 'lolproxchat.cloudflaredPath';

export function getStoredHostMode(): HostMode {
  try {
    const mode = localStorage.getItem(MODE_KEY);
    return mode === 'cloudflare' ? 'cloudflare' : 'direct';
  } catch {
    return 'direct';
  }
}

export function setStoredHostMode(mode: HostMode): void {
  localStorage.setItem(MODE_KEY, mode);
}

export function getStoredCloudflaredPath(): string {
  try {
    return localStorage.getItem(CLOUDFLARED_PATH_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setStoredCloudflaredPath(path: string): void {
  localStorage.setItem(CLOUDFLARED_PATH_KEY, path.trim());
}

export function getStoredHostEndpointFields(): ServerEndpointFields {
  try {
    return {
      protocol: localStorage.getItem(PROTOCOL_KEY) ?? '',
      host: localStorage.getItem(HOST_KEY) ?? '',
      port: localStorage.getItem(PORT_KEY) ?? '',
    };
  } catch {
    return { protocol: '', host: '', port: '' };
  }
}

export function getStoredHostEndpoint(): ServerEndpoint | null {
  const parsed = parseServerEndpoint(getStoredHostEndpointFields());
  return parsed.ok ? parsed.endpoint : null;
}

export function setStoredHostEndpoint(fields: ServerEndpointFields): void {
  const parsed = parseServerEndpoint(fields);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  const { protocol, host, port } = parsed.endpoint;
  localStorage.setItem(PROTOCOL_KEY, protocol);
  localStorage.setItem(HOST_KEY, host);
  localStorage.setItem(PORT_KEY, String(port));
}

export function clearStoredHostEndpoint(): void {
  try {
    localStorage.removeItem(PROTOCOL_KEY);
    localStorage.removeItem(HOST_KEY);
    localStorage.removeItem(PORT_KEY);
  } catch { /* ignore */ }
}

export function readHostPort(fields: ServerEndpointFields): number | null {
  const parsed = parseServerEndpoint(fields);
  return parsed.ok ? parsed.endpoint.port : null;
}
