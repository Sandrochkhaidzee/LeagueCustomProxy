# Architecture

How LoLProxChat actually works under the hood. Audience: contributors and curious users. For day-to-day usage, see the [user guide](user-guide.md). For the threat model, see [`threat-model.md`](threat-model.md).

## The 30-second version

LoLProxChat reads your in-game position by **computer vision on the minimap**, exchanges **encrypted position blobs** peer-to-peer over WebRTC data channels, sends the encrypted blobs to a **stateless signaling server** that decrypts them just long enough to compute pairwise **proximity volumes**, and applies those volumes to **WebRTC voice streams** that flow directly between players.

No client ever sees a decrypted peer position. No audio touches the server.

## System map

```
┌────────────────────────────────────────────────────────────────────┐
│  Player's machine — lolproxchat.exe (Tauri 2)                      │
│                                                                    │
│  ┌──────────────────┐         ┌───────────────────────┐            │
│  │  Rust backend    │         │  WebView2 frontend    │            │
│  │  ────────────    │         │  ─────────────────    │            │
│  │  • Win32 BitBlt  │◄────────┤  Orchestrator         │            │
│  │    minimap cap   │         │  (game-state polling, │            │
│  │  • LCU + Live    │────────►│   session lifecycle,  │            │
│  │    Client poll   │         │   position broadcast) │            │
│  │  • Window pos    │         │                       │            │
│  │  • Global keys   │         │  TrackingService      │            │
│  │  • Updater       │         │  (CV pipeline)        │            │
│  │  • Log rotation  │         │                       │            │
│  └──────────────────┘         │  AudioService         │            │
│                               │  (mic, peers, volume) │            │
│                               │                       │            │
│                               │  SignalingService     │            │
│                               │  PeerConnection × N   │            │
│                               │  DataChannelService   │            │
│                               │  VolumeClient         │            │
│                               └───────────────────────┘            │
└────────────┬────────────────────────────────┬──────────────────────┘
             │                                │
             │  WSS + HTTPS                   │  WebRTC P2P
             │                                │  (DTLS-SRTP voice,
             ▼                                │   encrypted data
   ┌────────────────────────┐                 │   channel blobs)
   │  Signaling server      │                 │
   │  (Node, /mnt/user/      │                 │
   │   appdata/proxchat-     │                 │
   │   server on Unraid)    │                 │
   │  ───────────────────   │                 │
   │  • /ws  room presence  │                 │
   │  • /compute-volumes    │                 │
   │    (AES-GCM decrypt,   │                 │
   │     dist→volume math)  │                 │
   │  • /turn-credentials   │                 │
   │    (Cloudflare proxy)  │                 │
   │  • /health             │                 │
   └────────────┬───────────┘                 │
                │                             │
                │  HTTPS                      │  TURN UDP/TCP/TLS
                ▼                             ▼
   ┌────────────────────────┐    ┌────────────────────────┐
   │  Cloudflare Realtime    │    │  Cloudflare Realtime   │
   │  TURN API               │    │  TURN relay            │
   │  (credential issuance) │    │  (turn.cloudflare.com) │
   └────────────────────────┘    └────────────────────────┘
```

## The three windows

Since v0.1.21 the client runs two Tauri windows, both inside a single WebView2 process:

- **`overlay`** — the **panel** window. Draggable, holds the player list and Settings. Visible, captures input over its hit-rect, click-through everywhere else (via a 30 Hz cursor-position polling loop in `main.rs`).
- **`scanner`** — a transparent click-through window auto-pinned over the detected minimap region. Empty in normal use. When Debug is on, it paints a small tracking dot showing where the CV thinks you are. *Doesn't* paint the HSV-filtered debug image — that lives in the panel's Settings to avoid a capture-feedback loop.

A short-lived third "window" is the splash visible at startup before the orchestrator boots; it's just the panel before CV locks on.

Both windows are declared in `src-tauri/tauri.conf.json`. Both have transparent backgrounds, no decorations, `alwaysOnTop`, no shadow. Capability grants live at `src-tauri/capabilities/default.json` (drag + event emit/listen — without this Tauri 2 silently denies built-in IPC).

## The CV pipeline (`src/services/tracking.ts`)

Tracking is a state machine: **SCANNING → LOCKED → (DEAD)**. Every CV tick:

1. **Capture.** `invoke('capture_minimap')` triggers a Win32 `BitBlt` of a bounded screen rect. Tauri returns the raw RGBA bytes as a data URL.
2. **Color mask.** Build HSV-thresholded masks for each plausible champion-circle color (teal allies + various enemy hues). Tracked via `buildWhiteMasks` / `findBlobs`.
3. **Blob detection.** Flood-fill connected components, filter by size + fill-ratio against the expected icon diameter at the current minimap scale.
4. **Classifier.** When uncertain (multiple candidate blobs, or recovering from a hold), crop each candidate and run it through the ONNX champion classifier (`src/services/champion-classifier.ts`). The classifier is a small CNN trained on champion circle icons; runs in the WASM ONNX Runtime in the audio-thread-adjacent worker.
5. **Track.** In LOCKED state, prefer the blob nearest to last position + velocity; rebuild velocity as an EMA on apparent motion. Allow brief "holds" (no match in range) using extrapolation with a velocity cap (10 px/tick — see `extrapolatePosition`).
6. **Position-jump detection.** All `lastPosition` writes funnel through `setLastPosition`, which warns if the implied velocity exceeds 2000 game-units/sec — far above any legitimate champion movement, so any warning hits indicate either a real teleport (recall) or a CV mis-track.

Edge cases the state machine handles: champion deaths (icon disappears), respawn at fountain (re-acquire via classifier), camera pan, overlapping icons in teamfights, minimap scale changes via `game.cfg` MinimapScale.

## Position privacy + volume math

This is the part that matters for both the threat model and the "what does the server see" question.

1. The client encrypts its position with **AES-GCM** using a key only the server has. Includes a timestamp inside the encrypted payload so the server can age-check on decrypt.
2. The client sends the **encrypted blob** to every peer via the WebRTC data channel. Peers can't decrypt it — they just relay it back to the server in their own next `/compute-volumes` request.
3. On each volume tick, the client POSTs to `/compute-volumes` with its own raw position + the bag of encrypted peer blobs it received this cycle.
4. The server decrypts each peer blob, computes the pairwise distance, applies quadratic falloff (`1 - (d/MAX_HEARING_RANGE)²`), snaps the result to one of 5 buckets (`0`, `0.20`, `0.45`, `0.75`, `1.0`), applies ±5% multiplicative jitter, and returns only `{ peerName: volume }` to the requesting client.
5. The server also returns the requester's own freshly-encrypted blob (`myBlob`) for the next round of peer-to-peer broadcast.

The result: **a peer client never sees another client's raw position, and the volume value it receives carries about ~250 units of distance uncertainty per bucket plus the jitter noise floor.** Server quantization details in `server/src/volumes.ts`; threat-model rationale in [`threat-model.md`](threat-model.md).

## WebRTC voice flow

Voice is a parallel concern from positions — runs on the same `RTCPeerConnection` but completely independent of the data channel.

- Each client publishes a single mic stream through a WebAudio graph: `mic → GainNode → MediaStreamDestination → RTCPeerConnection`.
- Each peer's incoming stream goes through the inverse: `RTCPeerConnection → MediaStreamSource → GainNode → AudioContext.destination`.
- The per-peer gain is driven by the server-returned volume, smoothed by an EMA (`nextSmoothedVolume`) with a 0.3 alpha cap so even sudden bucket transitions ramp over ~1 second instead of snapping.
- ICE candidates flow through the signaling server's `/ws` endpoint. Direct P2P (host or srflx) is preferred; TURN relay kicks in if the user opted into "Hide IP" or if direct paths fail. TURN credentials come from Cloudflare's Realtime TURN API, proxied through the signaling server's `/turn-credentials`.
- ICE failure auto-recovers: initiator side calls `pc.restartIce()` + re-issues an offer, capped at 2 attempts per peer, counter resets on successful re-connect.

## Signaling server (`server/`)

A ~500-LOC Node process. Single container deployed via Docker Compose. Stateless modulo the in-memory rooms table.

**Endpoints:**

- **`/ws`** — WebSocket upgrade. Handles room join/leave, peer presence broadcast, and relay of `offer` / `answer` / `ice-candidate` signals between named peers. Room IDs are deterministic hashes of sorted player summoner names, so any two players in the same match independently compute the same room ID.
- **`POST /compute-volumes`** — Receives `{ myPosition, peers: { name: encryptedBlob, ... } }`, returns `{ myBlob, peerVolumes }`. Quantized + jittered volumes, 24-hour-bounded blob ages.
- **`GET /turn-credentials`** — Returns ICE servers for the requesting client. Calls Cloudflare's TURN API in the background (cached in-process for 24 hours with stale-grace fallback on API failure). Falls back to self-hosted coturn HMAC credentials if `TURN_KEY_ID` is unset and `TURN_SERVER`/`TURN_SECRET` are set.
- **`GET /health`** — `{ status: "ok", rooms: N }`. Used by Docker healthcheck and the public status badge in the README.

Source files:

| File | Responsibility |
|---|---|
| `src/index.ts` | HTTP/WebSocket bootstrap, route dispatch |
| `src/ws-handler.ts` | Per-connection lifecycle, room messages |
| `src/rooms.ts` | In-memory room table, presence tracking |
| `src/volumes.ts` | AES-GCM blob encrypt/decrypt, quadratic falloff, bucket quantization, jitter |
| `src/turn.ts` | Cloudflare TURN credential fetcher + cache + coturn HMAC fallback |
| `src/types.ts` | Shared request/response types |

33 tests under `server/tests/`.

## Update flow

In-app updater (`src-tauri/src/updater.rs` + `src/services/updater.ts`):

1. On launch, if the user has Auto-update on (localStorage flag), wait ~5 seconds for the orchestrator to settle.
2. `GET https://api.github.com/repos/danthi123/LoLProxChat/releases/latest`, compare `tag_name` against `CARGO_PKG_VERSION`.
3. If newer: prefer the `lolproxchat.exe` asset's `browser_download_url`, fall back to any `.exe`. Stream-download to `<current-exe-dir>/<current-exe-name>.new`.
4. Spawn the new binary with `--complete-update <old-path>` and exit.
5. The new process waits ~800 ms (so the old process releases its file lock), deletes the old `.exe` with up to 5 retries, then renames `.new` → `.exe` (renaming a running `.exe` is allowed on Windows; deleting one isn't).

Manual checks (Settings → Updates → CHECK) skip the launch delay and the Auto-update gate.

## Key client services (under `src/services/`)

| Service | Responsibility |
|---|---|
| `Orchestrator` | Game-state polling, session lifecycle, broadcast cadence, scanning-mode passthrough, peer state registry. The wiring layer between everything else. |
| `TrackingService` | Minimap CV pipeline. State machine described above. |
| `ChampionClassifier` | ONNX Runtime Web (WASM backend) inference for champion-icon identification. |
| `AudioService` | WebRTC audio + per-peer volume control. Input mode toggle (Always Open / PTT). Mic acquisition with selected device. Output via shared `AudioContext`. Noise suppression handled natively by Chromium. |
| `SignalingService` | WebSocket presence + signal relay. Auto-reconnect with exponential backoff. |
| `PeerConnection` | Single peer's `RTCPeerConnection` wrapper. EMA-smoothed gain, periodic `getStats()` logging, ICE-restart on failure, ICE-transport-policy reading from privacy settings. |
| `VolumeClient` | Calls `/compute-volumes` with encrypted blobs. |
| `DataChannelService` | WebRTC data-channel multiplexer for encrypted blob exchange. |
| `GameStateService` | Wraps Tauri commands for LCU + Live Client Data into a TypeScript surface. |
| `Devices` | localStorage-backed input/output audio device pick. |
| `Privacy` | localStorage-backed Force-TURN toggle. |
| `Updater` | Thin wrapper over the Rust update commands. |

## Key Rust commands (under `src-tauri/src/`)

| Command (file) | Responsibility |
|---|---|
| `capture::set_capture_bounds`, `capture::capture_minimap` | Win32 GDI BitBlt of a bounded screen rect into an RGBA data URL. |
| `lcu::check_league_running`, `lcu::get_game_state`, `lcu::get_live_client_data`, `lcu::read_text_file`, `lcu::get_league_install_dir` | LCU + Live Client Data polling. Install-dir resolution via the LCU lockfile path. |
| `updater::check_for_update`, `updater::download_and_apply_update` | GitHub Releases check + in-place exe swap. Handles the `--complete-update <old-path>` startup arg. |
| `main::position_scanner`, `main::hide_scanner` | Auto-pin the scanner window over the detected minimap region. |
| `main::get_screen_size` | Primary monitor resolution for DPI math. |
| `main::set_panel_size` | Reports the panel's current hit-rect size to the click-through polling loop. |
| `main::append_log` | Writes a single line to the rolling debug log file. |
| `main::open_log_folder` | Launches Explorer at the log directory. |

`main.rs` also runs the cursor-position polling loop (30 Hz, skipped while LMB held to avoid tearing down a native window-drag), registers global shortcuts (`Ctrl+Shift+M` toggle mute, `F8` PTT), opens the rolling log file at startup with 3-session rotation, and routes `tauri::WindowEvent::CloseRequested` on any window to `app.exit(0)`.

## What's intentionally not here

A few design choices that look odd until you know the constraints:

- **No `tauri dev` workflow.** No webpack dev server is configured. The iterative loop is `npx tauri build && src-tauri/target/release/lolproxchat.exe`. Adding `tauri dev` is plausible future work but the current cadence is ~60-90 s per iteration which is fast enough.
- **The signaling server is stateful only in-memory.** Rooms vanish on restart. This is intentional — restarts are rare, clients reconnect, and the alternative (a stateful presence DB) is a much bigger ops surface for no real benefit.
- **No code signing.** Code-signing certs are paid + tied to a legal entity. The release flow includes a SHA-256 hash in every release body instead (see the README's verification section).
- **Anti-cheat hardening lives server-side, not client-side.** The client just plays whatever volume the server returns. Client-side bucketing or rounding wouldn't help — a modified client would just bypass it.

## Where the code-base is going next

See open issues and the [CHANGELOG](../CHANGELOG.md). Roughly in priority order:

- **Rebindable hotkeys + low-level keyboard hook** (`#1`). Tauri's `RegisterHotKey` gets pre-empted by DirectInput consumers; needs a `WH_KEYBOARD_LL` hook on the Rust side.
- **Asymmetric voice issue** (`#7`). Diagnostics are in place; waiting on dual-sided logs.
- **Server-side rate limiting** on `/turn-credentials` and `/compute-volumes` to bound the worst-case Cloudflare quota burn from a malicious user.
- **Cloudflare TURN usage monitoring** — alert before approaching the 1 TB/month cap.

For the longer view, refer to issue [#10](https://github.com/danthi123/LoLProxChat/issues/10) (anti-cheat hardening backlog) and the historical design docs under `docs/plans/`.
