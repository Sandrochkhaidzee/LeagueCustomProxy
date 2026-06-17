import {
  parseServerEndpoint,
  type ServerEndpoint,
  type ServerEndpointFields,
} from './server-endpoint';

const PROTOCOL_KEY = 'lolproxchat.hostProtocol';
const HOST_KEY = 'lolproxchat.hostIp';
const PORT_KEY = 'lolproxchat.hostPort';

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
