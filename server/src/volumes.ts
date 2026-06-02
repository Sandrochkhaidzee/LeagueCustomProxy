const crypto = globalThis.crypto;

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
  return crypto.subtle.importKey('raw', keyBytes.buffer as ArrayBuffer, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
}

// ---------- public API ----------

// Quantize the continuous volume into discrete bands. Reduces the precision
// of the "how close exactly is this peer" side channel a modified client can
// extract — instead of a fractional distance estimate, an attacker only learns
// which tier the peer is in. Audio impact is negligible because the
// client-side EMA in PeerConnection.setVolume ramps between bucket values
// over ~1 second, so the audible transition is still smooth.
// Buckets (chosen for roughly equal perceptual loudness steps):
//   silent: vol === 0
//   distant: 0 < vol ≤ 0.25  → snap to 0.20
//   nearby:  0.25 < vol ≤ 0.55 → snap to 0.45
//   close:   0.55 < vol ≤ 0.85 → snap to 0.75
//   adjacent: vol > 0.85       → snap to 1.0
const VOLUME_BUCKETS: { max: number; value: number }[] = [
  { max: 0.0, value: 0.0 },
  { max: 0.25, value: 0.20 },
  { max: 0.55, value: 0.45 },
  { max: 0.85, value: 0.75 },
  { max: Infinity, value: 1.0 },
];

function quantizeVolume(v: number): number {
  for (const b of VOLUME_BUCKETS) {
    if (v <= b.max) return b.value;
  }
  return 1.0;
}

// Multiplicative jitter on the bucket value (±JITTER_PCT). Two modified
// clients comparing samples can't extract exact distance ratios since each
// snapshot is slightly perturbed. Bounded so we never cross a bucket boundary
// (jitter << gap between adjacent bucket values).
const JITTER_PCT = 0.05;
function jitterVolume(v: number): number {
  if (v <= 0) return 0;
  const noise = 1 + (Math.random() * 2 - 1) * JITTER_PCT;
  return Math.max(0, Math.min(1, v * noise));
}

export function calculateVolume(distance: number): number {
  if (distance >= MAX_HEARING_RANGE) return 0.0;
  if (distance <= 0) return 1.0;
  // Quadratic falloff — more generous in the mid-range than the previous
  // logarithmic curve. At MAX/2: log gave ~0.38, quadratic gives 0.75.
  const normalized = distance / MAX_HEARING_RANGE;
  const continuous = Math.max(0, 1 - normalized * normalized);
  return jitterVolume(quantizeVolume(continuous));
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
