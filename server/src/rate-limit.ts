// Simple in-memory token-bucket rate limiter. No external dependency.
//
// Per-IP and per-connection limits are tracked in maps; idle buckets are
// pruned by a periodic sweep. The state is process-local — if you scale to
// multiple replicas, swap this for Redis or a CRDT bucket. We deliberately
// don't reach for an external dep here: the signaling server is supposed to
// stay ~500 LOC and trivially self-hostable.
//
// Limits are tuned for a real LoL game: 10 Hz position broadcasts, occasional
// signaling bursts at game start, premades sharing a household NAT (so >1
// connection per IP is normal). See `LIMITS` below.

export interface RateLimitConfig {
  /** Maximum tokens the bucket can hold. */
  capacity: number;
  /** Tokens added per second. */
  refillPerSec: number;
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

export class TokenBucket {
  private buckets = new Map<string, Bucket>();
  private readonly cfg: RateLimitConfig;

  constructor(cfg: RateLimitConfig) {
    this.cfg = cfg;
  }

  /**
   * Try to consume one token for the given key. Returns true if granted,
   * false if the bucket is empty (request should be rejected with 429).
   */
  tryConsume(key: string, now: number = Date.now()): boolean {
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.cfg.capacity, lastRefillMs: now };
      this.buckets.set(key, b);
    }
    // Refill since last visit
    const elapsedSec = (now - b.lastRefillMs) / 1000;
    if (elapsedSec > 0) {
      b.tokens = Math.min(this.cfg.capacity, b.tokens + elapsedSec * this.cfg.refillPerSec);
      b.lastRefillMs = now;
    }
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return true;
    }
    return false;
  }

  /**
   * Drop buckets that haven't been touched in `idleMs`. Call periodically to
   * prevent unbounded growth when lots of unique IPs hit the server briefly.
   */
  pruneIdle(idleMs: number, now: number = Date.now()): number {
    let removed = 0;
    for (const [k, b] of this.buckets) {
      if (now - b.lastRefillMs > idleMs) {
        this.buckets.delete(k);
        removed += 1;
      }
    }
    return removed;
  }

  /** Snapshot for /health diagnostics or tests. */
  get size(): number {
    return this.buckets.size;
  }
}

/** Per-connection concurrency counter. Used to cap WS connections per IP. */
export class ConcurrencyLimiter {
  private counts = new Map<string, number>();

  constructor(public readonly max: number) {}

  acquire(key: string): boolean {
    const cur = this.counts.get(key) ?? 0;
    if (cur >= this.max) return false;
    this.counts.set(key, cur + 1);
    return true;
  }

  release(key: string): void {
    const cur = this.counts.get(key) ?? 0;
    if (cur <= 1) this.counts.delete(key);
    else this.counts.set(key, cur - 1);
  }

  count(key: string): number {
    return this.counts.get(key) ?? 0;
  }

  get size(): number {
    return this.counts.size;
  }
}

/**
 * Limits tuned for the real workload:
 *
 * /turn-credentials — clients call this once per peer connection (≈ once
 *   per game; maybe again on ICE restart). 60/min per IP is far above what
 *   any legit client should ever need but bounds the worst-case Cloudflare
 *   quota burn from a malicious script.
 *
 * /compute-volumes — fires at the 10 Hz position tick during gameplay. 900
 *   req/min per IP = 15/sec sustained, 50% headroom over the 10 Hz baseline
 *   so brief bursts (settle-in after game start, multiple users sharing one
 *   NAT'd IP) are absorbed. Lower bound is well under what a real script
 *   attack could push.
 *
 * /ws connections per IP — premades from a single household + buffer for
 *   reconnect-during-restart situations. 20 covers most real cases; CG-NAT
 *   ISPs (mobile, some apartments) sharing one IP among many subscribers
 *   would benefit from a higher number — adjust here if you self-host into
 *   such an environment.
 *
 * /ws messages per connection — position broadcasts at 10 Hz + signaling
 *   bursts at game start + occasional ICE-candidate batches. 60/sec is a
 *   generous cap that still prevents flood-relay abuse through a legit
 *   joiner.
 */
export const LIMITS = {
  TURN_CREDS: { capacity: 60, refillPerSec: 1 },        // 60/min, no burst
  COMPUTE_VOLUMES: { capacity: 30, refillPerSec: 15 },  // 15/sec sustained, 2-sec burst
  WS_MESSAGES: { capacity: 120, refillPerSec: 60 },     // 60/sec sustained, 2-sec burst
  WS_PER_IP: 20,
  BODY_BYTES: 256 * 1024,                                // /compute-volumes body cap
  WS_PAYLOAD_BYTES: 64 * 1024,                           // single WS message cap
} as const;

/**
 * Extract the client IP from a Node `IncomingMessage`. Honors `x-forwarded-for`
 * for setups behind a reverse proxy (Caddy, nginx, Cloudflare, etc.); falls
 * back to the socket remote address.
 */
export function clientIp(req: { headers: Record<string, string | string[] | undefined>, socket: { remoteAddress?: string } }): string {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    // x-forwarded-for is a comma-separated list; the leftmost entry is the
    // original client.
    const first = xff.split(',')[0].trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? 'unknown';
}
