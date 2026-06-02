# Threat Model — Cheat / Information Leak

This document covers what the LoLProxChat design protects against in terms of using the app to gain an unfair information advantage in League of Legends, and what it explicitly does not protect against. It does **not** cover broader user-facing threats (network privacy, server operator trust, etc.) — those are tracked separately.

## Design intent

A user running a modified ("cheating") client should not be able to derive enemy player locations from the app's data. The proximity-audio experience should not give a stock client noticeably more game information than a normal Riot vision-range check would.

## What the design protects

### Raw position data is never sent in plaintext between clients

- Clients encrypt their own position with **AES-256-GCM** before broadcasting it.
- The encryption key lives only on the signaling server, in the `ENCRYPTION_KEY` environment variable. Clients never see it.
- Peer position blobs flow over WebRTC data channels client-to-client, but neither client can decrypt them.
- The server is the only entity that can decrypt a peer's position to compute volumes.

### Blob freshness check prevents replay

- Each encrypted blob includes a timestamp.
- The server's `decryptPosition` rejects blobs older than `BLOB_MAX_AGE_MS` (10 seconds, sized to absorb client/server clock skew).
- A modified client recording another player's blob stream and replaying it later can't generate stale-data movement traces — the server treats expired blobs as undecryptable.

### Server returns volumes, not positions

- The `/compute-volumes` response is `{ "PeerName": volume, ... }` where each volume is a number between 0 and 1.
- No coordinate data leaves the server.

### Volumes are quantized + jittered before being returned (v0.1.26+)

- Continuous distance-to-volume math runs server-side, then the result is snapped to one of five discrete buckets: `0`, `0.20`, `0.45`, `0.75`, `1.0`.
- Each bucket value is then multiplied by ±5% random jitter before being returned.
- This means a modified client can't extract a precise distance estimate from the volume — only a coarse tier (silent / distant / nearby / close / adjacent), and even that tier carries random noise per request.
- The client-side EMA in `PeerConnection.setVolume` (~1s ramp) smooths bucket transitions so the audible experience is unaffected.

## What the design does not protect

### Volume itself is a coarse side channel

- A modified client can read its per-peer volume vector to learn whether an enemy is within `MAX_HEARING_RANGE` (1200 game units, calibrated to roughly match LoL vision range).
- That binary "enemy is in audible range" signal is information the stock game wouldn't provide if the enemy is in fog of war.
- The bucket quantization reduces this to "in range, and roughly which tier of distance" rather than a precise distance.
- This leak is **inherent to proximity audio existing at all** — closing it would mean abandoning the feature.

### Two coordinated modified clients can triangulate

- If two players in the same lobby both run modified clients and share their per-peer volume vectors out-of-band, distance estimates from two known points can localize an enemy.
- Bucket quantization + jitter make the localization fuzzy (precision bounded by bucket width, ~250-300 game units per tier) but don't eliminate it.
- A determined cheat ring with multiple modified clients can reduce the fuzz further by averaging many samples — jitter is i.i.d. per request, so noise drops as `sqrt(N)`.

### Single-client self-reported position trust

- Each client tells the server "I'm at (X, Y)" with no way for the server to verify.
- A modified client can broadcast a fake position to make itself appear at base, at an enemy's location, or anywhere else.
- This is fundamentally unfixable without Riot exposing authoritative game state to third-party tools (they don't).

### The server operator can read positions

- Whoever holds `ENCRYPTION_KEY` can decrypt any blob they see.
- A malicious operator running the signaling server can log decrypted positions of every player in every game using their server.
- Trust in the server operator is required — this is why the default deployment uses a server we control. Users who don't trust that can self-host and point their client at their own deployment.

## Calibration of `MAX_HEARING_RANGE`

The 1200-game-unit hearing range was chosen to roughly match the radius at which a player would already gain visual information about an enemy in stock LoL (champion vision range, ward range, brush vision). The intent is that a stock client doesn't expose information the player wouldn't have anyway — the audio "fades in" right around when the enemy would become visible or warded.

If this range is increased, the side-channel value to a modified client grows. If decreased, the proximity-audio experience loses utility (you can only hear teammates in melee range of each other). The current value is the result of those competing pressures.

## Mitigations applied vs. mitigations possible

| Mitigation | Status | Notes |
|---|---|---|
| Server-side AES-GCM blob encryption | Applied | Since first release |
| Blob age check (10s) | Applied | In `decryptPosition` |
| Volume quantization to 5 buckets | Applied (v0.1.26) | See `VOLUME_BUCKETS` in `server/src/volumes.ts` |
| ±5% multiplicative jitter on returned volumes | Applied (v0.1.26) | See `jitterVolume` |
| Drop volumes below a noise floor | Not applied | Would prevent "barely audible = exactly N units away" signaling; minor extra hardening on top of buckets |
| Snap positions to a coarse grid client-side before encrypting | Not applied | Lossy at source; would survive even key compromise. Would also slightly degrade volume accuracy for legitimate users |
| Reduce `MAX_HEARING_RANGE` | Not applied | Would shrink the side channel proportionally but also shrink the proximity-audio feature itself |
| Stateful per-pair smoothing on the server | Not applied | Would resist sample averaging but adds per-room state to the server and undoes the stateless-math-function design |

The applied mitigations raise the floor for casual abuse without imposing measurable cost on legitimate use. The unapplied mitigations are tracked in [issue #10](https://github.com/danthi123/LoLProxChat/issues/10) for consideration if abuse becomes evident in the wild.
