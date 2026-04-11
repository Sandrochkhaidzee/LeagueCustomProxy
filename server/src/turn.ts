import { webcrypto } from 'node:crypto';

export interface IceServer {
  urls: string;
  username?: string;
  credential?: string;
}

export async function generateTurnCredentials(
  turnServer: string,
  turnSecret: string,
): Promise<{ iceServers: IceServer[] }> {
  if (!turnServer || !turnSecret) {
    return { iceServers: [] };
  }

  const expiry = Math.floor(Date.now() / 1000) + 24 * 3600;
  const username = `${expiry}:proxchat`;

  const encoder = new TextEncoder();
  const key = await webcrypto.subtle.importKey(
    'raw',
    encoder.encode(turnSecret),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const sig = await webcrypto.subtle.sign('HMAC', key, encoder.encode(username));
  const credential = Buffer.from(sig).toString('base64');

  const iceServers: IceServer[] = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: `stun:${turnServer}:3478` },
    { urls: `turn:${turnServer}:3478`, username, credential },
    { urls: `turns:${turnServer}:5349`, username, credential },
  ];

  return { iceServers };
}
