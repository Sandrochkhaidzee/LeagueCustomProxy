# Threat Model

This document describes the threats LoLProxChat protects against, the threats it doesn't, and the mitigations applied or available. Two broad categories:

1. **Cheat / information leak** — using the app to gain an unfair in-game advantage
2. **Threats to users** — privacy, network, trust risks faced by people who run the app

---

# Part 1 — Cheat / Information Leak

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

---

# Part 2 — Threats to Users

These are risks the *user* takes on by running the app, separate from in-game cheating. Some are mitigated, some are documented-and-accepted.

## What we don't collect

LoLProxChat collects **no analytics, no telemetry, no usage statistics, no crash reports, no device fingerprints, and no persistent user identifiers.** There are no user accounts. There is no third-party analytics SDK. The signaling server does not log per-user activity beyond what's needed to route a single in-flight request.

The only data that ever leaves the user's machine is:

- **Summoner name** — sent to the signaling server so peers in the same match can find each other in a room. Same name visible to anyone on the match scoreboard.
- **Encrypted position blob** — AES-GCM-encrypted with a server-only key, sent so the server can compute proximity volumes. Decrypted server-side, never logged or persisted, dropped immediately after the volume math runs.
- **WebRTC signaling messages** (SDP offers/answers, ICE candidates) — exchanged peer-to-peer via the signaling server as a relay. Standard WebRTC handshake; contains your public IP unless `Hide IP (Force TURN)` is enabled (see below).
- **Voice audio** — flows peer-to-peer over DTLS-SRTP, never touches the signaling server. Goes through the TURN relay (Cloudflare) only if direct P2P fails or `Hide IP (Force TURN)` is on, and even then the relay can't decrypt it.

The only data persisted locally is:

- **Settings** — input mode, mic/speaker device IDs, volume preferences, auto-update opt-in, Hide-IP toggle, per-player mute prefs. Stored in WebView2 localStorage at `%LOCALAPPDATA%\com.proxchat.app\`. Never sent anywhere.
- **Debug log** (only when `Debug` is toggled on) — written to `%LOCALAPPDATA%\com.proxchat.app\lolproxchat.log`. Only leaves your machine if you manually attach it to a GitHub issue. Rotates after 3 sessions.

There is no opt-in/opt-out switch for analytics because there is no analytics. The same applies to any future release — if telemetry is ever introduced, it will be opt-in, explicitly documented here, and clearly visible in Settings.

## Public IP exposure via WebRTC ICE candidates

**Risk:** WebRTC peer connections exchange ICE candidates to figure out how to reach each other. The "server-reflexive" (srflx) candidate contains each player's public IP, and that candidate is signaled to every peer in the match. A malicious player in the lobby can extract everyone else's public IP. With it, they can launch a DDoS against the home network, attempt port scanning, etc. This is the same class of risk Discord had pre-2017 before they forced all voice through their relays.

**Status:** **Mitigated by opt-in toggle (v0.1.27).**

- **Settings → Hide IP (Force TURN)** sets `iceTransportPolicy: 'relay'` on the RTCPeerConnection. Chromium then refuses to gather or use any non-relay candidate, so peers only ever see the TURN server's IP, never the user's public IP.
- Default is **off**, because TURN relay adds ~20-100 ms latency and uses TURN bandwidth (which we pay for via the Cloudflare free tier). Most users on default config still expose their IP to fellow players.
- Takes effect on the next peer connection (existing connections keep their original transport policy until re-established).
- Only matters in matches where you don't already trust everyone. If your premade is on Discord with you, your IP is already known to them via that channel — the toggle adds nothing then.

**Server-side mitigation alternative (not chosen):** forcing all clients TURN-only by default would protect users transparently but multiply server-side bandwidth costs and add latency for everyone. Opt-in keeps the cost on the users who choose it.

## Server operator can decrypt all positions

**Risk:** Whoever holds the `ENCRYPTION_KEY` on the signaling server can AES-GCM-decrypt every position blob they see in transit. A malicious or compromised server operator can log every player's movement in every game using their server.

**Status:** Not mitigated in code. Trust-or-self-host.

**Available controls:**

- Self-host the signaling server (see [`self-hosting.md`](self-hosting.md)) and point the client at it via the `PROXCHAT_SERVER` env var at build time. Eliminates third-party-operator trust.
- The default deployment points at a server we operate. Users who don't trust that operator should self-host.

**Why not end-to-end encrypt instead:** moving to per-room shared keys that the server can't decrypt would force volume math client-side. That undoes the anti-cheat design in Part 1 (clients would see peer positions directly). The trade-off favors keeping server-side decryption as the price of a meaningful anti-cheat posture.

## Summoner names visible in signaling traffic + logs

**Risk:** WebSocket signaling messages include summoner names. The signaling server sees them, the per-session debug log records them, anyone observing the network path between the client and the signaling server (e.g., an ISP doing TLS inspection on a corporate network) sees them inside the WebSocket frames.

**Status:** Accepted as low severity. Summoner names are gameplay-public — anyone who can see the match scoreboard already has them. The debug log warning ("contains your summoner name and nearby players' names") covers the case of users sharing logs publicly via GitHub issues.

## Code-signing absence → typosquatting risk

**Risk:** The release `.exe` is not code-signed (paid certificate tied to a legal entity, out of scope for a personal project). Windows shows a SmartScreen warning on first run, which the user has to override. A malicious lookalike binary would produce the same warning. A typosquatted GitHub release (e.g., a fork pretending to be official) is hard for users to distinguish from the real one.

**Status:** Partially mitigated.

- **SHA-256 hash published in every release body** (since v0.1.26+). The hash + per-OS verification instructions are included in the release notes. Users can compare their downloaded `.exe` against the official hash; anyone sharing the release link elsewhere (Reddit, Discord) can post the hash alongside.
- The hash defends against in-transit tampering, mirror reposts, and typosquatted re-uploads, but **does not defend against initial trust** — a user who downloads from the wrong GitHub URL has no way to know.
- Users wary of unsigned binaries can build from source (`npx tauri build`) — locally-built binaries skip the SmartScreen warning entirely.

## WebView2 process trust

**Risk:** The Tauri client loads the orchestrator + WebRTC code into a WebView2 process. Any vulnerability in the bundled WebView2 (which the WebView2 runtime updates separately via Microsoft Edge) could in principle let a crafted response from the signaling server execute code on the user's machine.

**Status:** Low practical risk, accepted.

- The attack surface is small: WebView2 only talks to one trusted signaling server endpoint (HTTPS-only) and one TURN provider.
- WebView2 receives security updates from Microsoft Edge automatically — no patching responsibility on us.
- A compromised signaling server could in principle target this vector, but a compromised signaling server has bigger problems (it already holds the encryption key and sees all signaling).

## Signaling-server presence enumeration

**Risk:** Anyone with WebSocket access to the signaling server, or its operator, can enumerate currently-active users (those connected to rooms right now). Tells an observer "this player is currently using LoLProxChat."

**Status:** Accepted as low severity. There is no public list, no API for enumeration. The threat requires either compromising the server or being its operator. Mitigations would require breaking presence-broadcast semantics, which is core to how peers discover each other.

## Voice content in transit

**Risk:** Voice flows P2P over WebRTC, but the media layer encryption is the standard DTLS-SRTP — anyone observing the network path can tell *that* there's voice traffic between two endpoints, just not what's being said.

**Status:** Standard WebRTC baseline. Not specifically mitigated. Not user-facing in any practical sense.

## Mitigations applied vs. mitigations possible (Part 2)

| Threat | Status | Notes |
|---|---|---|
| Analytics / telemetry / fingerprinting | **Not applicable** | None collected. No SDKs, no usage stats, no crash reporting service |
| Public IP exposure | **Mitigated (opt-in)** | Force-TURN toggle in Settings, v0.1.27+ |
| Server-operator decrypt | Doc-only | Self-host alternative documented in [`self-hosting.md`](self-hosting.md) |
| Summoner names visible | Accepted | Gameplay-public; redact-before-share warning in README |
| Code-signing absence | Partially mitigated | SHA-256 in release notes since v0.1.26+; build-from-source as full bypass |
| WebView2 process trust | Accepted | Auto-updated by Microsoft Edge; small attack surface |
| Signaling presence enumeration | Accepted | No mitigation without breaking peer-discovery |
| Voice in transit | Standard DTLS-SRTP | Inherent to WebRTC |
