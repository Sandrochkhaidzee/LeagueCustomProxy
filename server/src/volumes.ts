import { webcrypto } from 'node:crypto';

const MAX_HEARING_RANGE = 1200;
const BLOB_MAX_AGE_MS = 10_000; // 10s to handle clock skew

export interface VolumeRequest {
  myPosition: { x: number; y: number };
  peers: Record<string, string>; // name -> encrypted blob (base64)
}

export interface VolumeResponse {
  myBlob: string;
  peerVolumes: Record<string, number>;
}

// ---------- helpers ----------

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    const byte = parseInt(hex.substring(i, i + 2), 16);
    if (Number.isNaN(byte)) throw new Error('Invalid hex in encryption key');
    bytes[i / 2] = byte;
  }
  return bytes;
}

async function importKey(hexKey: string): Promise<CryptoKey> {
  if (!/^[0-9a-fA-F]{64}$/.test(hexKey)) {
    throw new Error('ENCRYPTION_KEY must be 64 hex chars (256-bit)');
  }
  const keyBytes = hexToBytes(hexKey);
  return webcrypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
}

// ---------- public API ----------

export function calculateVolume(distance: number): number {
  if (distance >= MAX_HEARING_RANGE) return 0.0;
  if (distance <= 0) return 1.0;
  const normalized = distance / MAX_HEARING_RANGE;
  return Math.max(0, 1 - Math.log1p(normalized * (Math.E - 1)));
}

export async function encryptPosition(
  hexKey: string,
  x: number,
  y: number,
): Promise<string> {
  const key = await importKey(hexKey);
  const timestamp = Date.now();
  const payload = new TextEncoder().encode(
    JSON.stringify({ x, y, t: timestamp }),
  );
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const encrypted = await webcrypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    payload,
  );
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(encrypted), iv.length);
  return Buffer.from(combined).toString('base64');
}

export async function decryptPosition(
  hexKey: string,
  blob: string,
): Promise<{ x: number; y: number } | null> {
  try {
    const key = await importKey(hexKey);
    const combined = new Uint8Array(Buffer.from(blob, 'base64'));
    const iv = combined.slice(0, 12);
    const ciphertext = combined.slice(12);
    const decrypted = await webcrypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      ciphertext,
    );
    const payload = JSON.parse(new TextDecoder().decode(decrypted));
    if (
      typeof payload.t !== 'number' ||
      Math.abs(Date.now() - payload.t) > BLOB_MAX_AGE_MS
    ) {
      return null;
    }
    return { x: payload.x, y: payload.y };
  } catch {
    return null;
  }
}

export async function computeVolumes(
  body: VolumeRequest,
  encryptionKey: string,
): Promise<VolumeResponse> {
  // Validate input
  if (
    !body.myPosition ||
    typeof body.myPosition.x !== 'number' ||
    typeof body.myPosition.y !== 'number' ||
    !isFinite(body.myPosition.x) ||
    !isFinite(body.myPosition.y)
  ) {
    throw new Error('Invalid position');
  }
  if (body.peers && typeof body.peers !== 'object') {
    throw new Error('Invalid peers');
  }

  const myBlob = await encryptPosition(
    encryptionKey,
    body.myPosition.x,
    body.myPosition.y,
  );

  const peerVolumes: Record<string, number> = {};
  for (const [name, peerBlob] of Object.entries(body.peers ?? {})) {
    const peerPos = await decryptPosition(encryptionKey, peerBlob);
    if (!peerPos) {
      peerVolumes[name] = 0;
      continue;
    }
    const dx = body.myPosition.x - peerPos.x;
    const dy = body.myPosition.y - peerPos.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    peerVolumes[name] = calculateVolume(distance);
  }

  return { myBlob, peerVolumes };
}
