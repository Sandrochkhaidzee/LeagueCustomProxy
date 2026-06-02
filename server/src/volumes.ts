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

// v0.1 request shape — peers field carries encrypted XY blobs from each peer.
// Kept for back-compat during the v0.2 transition; clients still on the old
// path send this. See computeVolumes() below.
export interface VolumeRequest {
  myPosition: { x: number; y: number };
  peers: Record<string, string>; // name -> encrypted blob (base64)
}

// v0.2 request shape — peers are read from server-side room state instead
// of being shipped in the request. See computeVolumesFromRoom() below.
export interface VolumeRequestV2 {
  myPosition: { x: number; y: number };
  roomId: string;
  name: string;
}

export interface VolumeResponse {
  myBlob: string;   // v0.1 path only; v0.2 returns "" since there's nothing to broadcast
  peerVolumes: Record<string, number>;
}

/**
 * How stale a peer's last-reported XY can be before the server skips them in
 * volume computation. 60 s gives plenty of slack for a client that briefly
 * stalls or has a network blip while still pruning ghost positions from
 * peers who hard-disconnected without a clean close.
 */
const STALE_POSITION_MS = 60_000;

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

// ---------- v0.2 path: positions live in server-side room state ----------

/**
 * Reads peer XY positions from server-side room state (populated by
 * 'coords' WSS messages) and computes pairwise distance volumes for the
 * requester. No encryption involved on either side — the request is on
 * HTTPS, the room state lives in process memory.
 *
 * `getPositions` is injected so this stays unit-testable without a real
 * RoomManager. Pass `(roomId, exceptName) => rooms.getRoomPositions(...)`
 * from the HTTP handler.
 */
export function computeVolumesFromRoom(
  body: VolumeRequestV2,
  getPositions: (roomId: string, exceptName: string, staleMs: number) => Record<string, { x: number; y: number }>,
): VolumeResponse {
  if (
    !body.myPosition ||
    typeof body.myPosition.x !== 'number' ||
    typeof body.myPosition.y !== 'number' ||
    !isFinite(body.myPosition.x) ||
    !isFinite(body.myPosition.y)
  ) {
    throw new Error('Invalid position');
  }
  if (typeof body.roomId !== 'string' || !body.roomId) {
    throw new Error('Invalid roomId');
  }
  if (typeof body.name !== 'string' || !body.name) {
    throw new Error('Invalid name');
  }

  const positions = getPositions(body.roomId, body.name, STALE_POSITION_MS);
  const peerVolumes: Record<string, number> = {};
  for (const [name, pos] of Object.entries(positions)) {
    const dx = body.myPosition.x - pos.x;
    const dy = body.myPosition.y - pos.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    peerVolumes[name] = calculateVolume(distance);
  }

  // v0.2 doesn't produce a myBlob — there's nothing for the requester to
  // re-broadcast (server already has their position from the most recent
  // 'coords' message). Return empty string for type-shape compatibility
  // with the legacy response.
  return { myBlob: '', peerVolumes };
}
