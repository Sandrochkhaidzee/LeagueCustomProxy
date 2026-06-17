export type ServerProtocol = 'http' | 'https';

export interface ServerEndpoint {
  protocol: ServerProtocol;
  host: string;
  port: number;
}

export interface ServerEndpointFields {
  protocol: string;
  host: string;
  port: string;
}

export type ServerEndpointResult =
  | { ok: true; endpoint: ServerEndpoint }
  | { ok: false; error: string };

const HOST_RE =
  /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*|(?:\d{1,3}\.){3}\d{1,3})$/;

export function parseServerEndpoint(fields: ServerEndpointFields): ServerEndpointResult {
  const protocol = fields.protocol.trim().toLowerCase();
  if (protocol !== 'http' && protocol !== 'https') {
    return { ok: false, error: 'Select HTTP or HTTPS.' };
  }

  const host = fields.host.trim();
  if (!host) {
    return { ok: false, error: 'Enter the host IP or hostname.' };
  }
  if (!HOST_RE.test(host)) {
    return { ok: false, error: 'Enter a valid host IP or hostname.' };
  }

  const portStr = fields.port.trim();
  if (!portStr) {
    return { ok: false, error: 'Enter a port number.' };
  }
  const port = parseInt(portStr, 10);
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    return { ok: false, error: 'Port must be between 1 and 65535.' };
  }

  return {
    ok: true,
    endpoint: { protocol: protocol as ServerProtocol, host, port },
  };
}

/** Host with port omitted when it is the protocol default (443/80). */
export function formatHostPort(endpoint: ServerEndpoint): string {
  const defaultPort = endpoint.protocol === 'https' ? 443 : 80;
  return endpoint.port === defaultPort
    ? endpoint.host
    : `${endpoint.host}:${endpoint.port}`;
}

export function buildServerUrl(endpoint: ServerEndpoint): string {
  return `${endpoint.protocol}://${formatHostPort(endpoint)}`;
}

export function buildWsUrl(endpoint: ServerEndpoint): string {
  const wsProto = endpoint.protocol === 'https' ? 'wss' : 'ws';
  return `${wsProto}://${formatHostPort(endpoint)}/ws`;
}

/** Parse a full URL into endpoint fields (legacy migration). */
export function parseServerUrlToFields(url: string): ServerEndpointFields | null {
  try {
    const u = new URL(url.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname) return null;
    const protocol = u.protocol.replace(':', '');
    const port = u.port || (protocol === 'https' ? '443' : '80');
    return {
      protocol,
      host: u.hostname,
      port,
    };
  } catch {
    return null;
  }
}
