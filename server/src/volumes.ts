const crypto = globalThis.crypto;

const MAX_HEARING_RANGE = 1200;
// Max age of an encrypted position blob the server will accept before
// rejecting it as stale. Tuned to absorb common Windows-clock drift
// (NTP service can lag 10-30s in the wild — we saw this in issue #7
// where one user's clock was ~12s behind real time and every blob was
// being rejected, breaking proximity audio entirely on the other side).
// Security tradeoff: this is the replay window for a captured blob.
// 30s is fine because the volume side-channel is already coarsened by
// quantization + jitter (see docs/threat-model.md Part 1).
const BLOB_MAX_AGE_MS = 30_000;

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
  return crypto.subtle.importKey('raw', keyBytes.buffer as ArrayBuffer, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
}

// ---------- public API ----------

export function calculateVolume(distance: number): number {
  if (distance >= MAX_HEARING_RANGE) return 0.0;
  if (distance <= 0) return 1.0;
  // Quadratic falloff — more generous in the mid-range than the previous
  // logarithmic curve. At MAX/2: log gave ~0.38, quadratic gives 0.75.
  //
  // Reverted v0.1.26 quantization (5 buckets) + ±5% jitter in v0.1.33:
  // The bucket transitions produced audible "cliffs" in real gameplay,
  // especially when peer CV was jittering between teal blobs near each
  // other (issue #14 / #7 logs). The anti-cheat precision-protection
  // argument was marginal at our user scale; jitter alone wasn't
  // restoring smoothness because each new sample still crossed bucket
  // boundaries. Reverted to continuous output; client-side EMA handles
  // transitions naturally. See docs/threat-model.md Part 1 for the
  // updated mitigation table.
  const normalized = distance / MAX_HEARING_RANGE;
  return Math.max(0, 1 - normalized * normalized);
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
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
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
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      ciphertext,
    );
    const payload = JSON.parse(new TextDecoder().decode(decrypted));
    if (typeof payload.t !== 'number') {
      return null;
    }
    const ageMs = Date.now() - payload.t;
    if (Math.abs(ageMs) > BLOB_MAX_AGE_MS) {
      // Surface clock skew as a structured log so we can spot patterns in
      // user-reported voice issues (silent rejection used to swallow this).
      console.warn(
        '[volumes] blob rejected: age=' + ageMs +
        'ms exceeds limit ' + BLOB_MAX_AGE_MS + 'ms (client clock skew?)',
      );
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
