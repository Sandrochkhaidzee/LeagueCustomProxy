# LoLProxChat

Proximity voice chat for League of Legends. Hear nearby players with volume that scales by in-game distance, tied to minimap vision — if you can't see them, you can't hear them.

Standalone Windows desktop app built with Tauri 2 + WebView2. No Overwolf, no third-party voice service.

## Install

Download the latest `proxchat.exe` from [Releases](https://github.com/danthi123/LoLProxyChat/releases/latest). It's a single portable executable — no installer.

**Requirements:**
- Windows 10 1809+ or Windows 11
- WebView2 Runtime (ships with Windows 11; pushed via Edge on Windows 10)
- **League of Legends must be set to Borderless mode** (Settings → Video → Window Mode → Borderless). True fullscreen takes exclusive GPU output and no transparent overlay — including this one — can render over it. Borderless is functionally identical performance-wise.

Launch the exe before or during a League match. The overlay auto-attaches beside the minimap once a game is detected.

## Controls

- **Panel buttons:** MIC (self-mute toggle), VOL (mute everyone), SET (settings panel), » (collapse panel)
- **Per-player MUTE button** in each row mutes that specific player for you
- **Global shortcuts** (work even when the game has focus, provided LoL is in borderless):
  - `Ctrl+Shift+M` — toggle self-mute
  - `F8` (hold) — push-to-talk (only effective when Input Mode is set to "Push to Talk" in Settings; default is "Always Open")

## Auto-update

Disabled by default. Enable in **Settings → Auto-update**. When on, the app checks GitHub Releases ~5 seconds after launch and, if a newer version is published, downloads and applies it automatically (process exits, new binary takes over, old one is cleaned up). You can also force a manual check anytime via **Settings → Updates → CHECK**. The setting persists across launches.

## How It Works

1. **Game detection** — Polls the League Client (LCU) for game phase, then the Live Client Data API for player roster and your summoner identity. No memory reading.
2. **Position detection** — Win32 BitBlt captures the minimap region, HSV color filtering + blob detection finds champion icons, and an ONNX champion classifier identifies which blob is your own champion.
3. **Signaling** — Players in the same game join a deterministic WebSocket room (room ID = hash of sorted player names) on a self-hosted Node server.
4. **Voice** — WebRTC peer-to-peer audio between players; no audio touches any server.
5. **Proximity volume** — Server-side AES-GCM encrypted position blobs + volume computation, so no client learns another player's exact position. Quadratic falloff up to 1200 game units (matches typical LoL vision range — if you can't see them, you can't hear them).
6. **Audio processing** — Chromium's native WebRTC noise suppression + echo cancellation + AGC (runs in native audio thread). Opus at 128 kbps.

## Usage

1. Make sure LoL is set to **Borderless** mode (Settings → Video → Window Mode → Borderless).
2. Launch `proxchat.exe`. The panel appears in the middle of the screen until a game starts (it'll show the current lifecycle phase — "Waiting for League of Legends", "In champion select", etc).
3. Once you load into a match the panel jumps to the left edge of the minimap. Other players also running ProxChat in the same match will appear in the list within a few seconds.
4. **Always Open** mic is the default — just talk and they'll hear you, scaled by in-game distance. Switch to **Push to Talk (F8)** in Settings if you'd prefer.
5. Click **MIC** to self-mute, **VOL** to mute everyone, or the per-row **MUTE** button to silence a specific player.

## Uninstall

Because it's a portable exe with no installer, removing it is a two-step process:

1. **Delete the exe** wherever you put it (probably Downloads or a folder you chose).
2. **Delete WebView2 / app data:** `%LOCALAPPDATA%\com.proxchat.app\` — contains the WebView2 cache (cookies, localStorage, IndexedDB) and `proxchat.log` if you ever enabled Debug. Open `Run` (Win+R) and paste `%LOCALAPPDATA%\com.proxchat.app\` to find it.

That's the full footprint. No registry entries owned by ProxChat itself, no entries under `Programs and Features`, no startup tasks, no services.

## Architecture

```
proxchat.exe (Tauri 2)
├── Rust backend       — Win32 screen capture, LCU/Live Client polling, window positioning, global shortcuts
└── WebView2 frontend  — orchestrator, signaling, WebRTC, CV, ONNX champion classifier

server/                — Node WebSocket + HTTP signaling server
├── /ws                — WebSocket upgrade for room join, signaling, presence
├── /compute-volumes   — POST: encrypted position blobs → per-peer volumes
├── /turn-credentials  — GET: ephemeral HMAC TURN credentials
└── /health            — health check
```

**Key client services** (under `src/services/`):
- `Orchestrator` — wires game state → tracking → signaling → audio
- `TrackingService` — minimap CV pipeline (capture → HSV mask → blob detect → classifier)
- `ChampionClassifier` — ONNX Runtime Web (WASM backend) inference
- `AudioService` — WebRTC audio + per-peer volume control. Input mode: Always Open or Push to Talk (F8 global shortcut). Noise suppression handled natively by Chromium.
- `SignalingService` — WebSocket presence and signal relay with auto-reconnect (exponential backoff)
- `PeerConnection` — WebRTC with Opus 128 kbps, EMA-smoothed per-peer gain via WebAudio
- `VolumeClient` — calls `/compute-volumes` with encrypted blobs
- `DataChannelService` — WebRTC data channels for encrypted blob exchange
- `GameStateService` — wraps Tauri commands for LCU + Live Client Data

**Rust commands** (under `src-tauri/src/`):
- `capture.rs` — `set_capture_bounds`, `capture_minimap` (Win32 GDI BitBlt)
- `lcu.rs` — `check_league_running`, `get_game_state`, `get_live_client_data`, `read_text_file`
- `main.rs` — `position_overlay`, `get_screen_size`, `set_panel_size`, `append_log`. Also sets `WDA_EXCLUDEFROMCAPTURE` on the overlay window (so its own debug paint doesn't feed back into the next capture), polls cursor position to dynamically toggle click-through over non-panel regions, and registers global shortcuts (`Ctrl+Shift+M` toggle self-mute, `F8` push-to-talk).

## Build From Source

### Prerequisites
- [Node.js](https://nodejs.org/) 18+
- [Rust](https://rustup.rs/) (stable toolchain)
- Windows 10/11 with the WebView2 SDK headers (installed automatically by Tauri on first build)

### Build

```bash
npm install
cp .env.example .env       # optional — defaults to https://proxchat.dant123.com
npx tauri build
```

The portable exe lands at `src-tauri/target/release/proxchat.exe`.

For iterative dev, rebuild and relaunch:
```bash
npx tauri build && src-tauri/target/release/proxchat.exe
```
(No `tauri dev` workflow yet — there's no webpack dev server configured.)

### Client environment

Only one variable, baked in at build time:

| Variable | Default | Description |
|---|---|---|
| `PROXCHAT_SERVER` | `https://proxchat.dant123.com` | Base URL of the signaling server. WebSocket URL is derived (`https://` → `wss://`). |

## Self-Hosting the Signaling Server

The server is a small Node app (~500 LOC) that replaces what used to be a stack of Supabase containers. Run it under Docker on any always-on host with HTTPS.

```bash
cd server
docker compose -f ../docker-compose.proxchat.yml up -d
```

Or run it directly:

```bash
cd server
npm install
npm run build && npm start
```

### Server environment

| Variable | Required | Description |
|---|---|---|
| `PORT` | no (default `3100`) | HTTP/WebSocket port |
| `ENCRYPTION_KEY` | yes | 64-char hex (256-bit) key for AES-GCM position encryption |
| `TURN_SERVER` | optional | TURN/STUN server hostname (returned to clients) |
| `TURN_SECRET` | optional | coturn shared secret for HMAC credential generation |

If `TURN_SERVER`/`TURN_SECRET` are unset, clients fall back to Google STUN only — fine for most NAT setups, may fail behind symmetric NAT.

A working `docker-compose.proxchat.yml` is included at the repo root with the server + coturn sidecar. Front it with a TLS-terminating reverse proxy (Caddy, nginx, Traefik) that proxies `/` to `:3100` and supports WebSocket upgrades.

### Tests

```bash
cd server && npm test     # vitest — rooms, volumes, turn credentials
npm test                  # jest — core logic (room hashing, proximity, etc)
```

## Project Structure

```
src/
├── background/          — orchestrator entry point (loaded into the overlay window)
├── overlay/             — overlay window (HTML/CSS/TS)
├── core/                — pure logic modules (tested)
│   ├── config.ts        — server URL, ICE servers
│   ├── types.ts
│   ├── room.ts          — deterministic room ID hashing
│   ├── proximity.ts     — volume falloff math
│   ├── map-calibration.ts
│   ├── template-match.ts
│   └── streamer-detect.ts
└── services/            — runtime services (see Architecture above)

src-tauri/               — Tauri 2 Rust backend
├── src/
│   ├── main.rs
│   ├── capture.rs
│   └── lcu.rs
├── Cargo.toml
└── tauri.conf.json

server/                  — Node signaling server
├── src/
│   ├── index.ts         — HTTP + WebSocket server
│   ├── ws-handler.ts    — join, signal, position, presence
│   ├── rooms.ts         — room state
│   ├── volumes.ts       — AES-GCM blob encryption + volume math
│   ├── turn.ts          — TURN HMAC credential generation
│   └── types.ts
├── tests/
└── Dockerfile

models/
├── champion_classifier.onnx
└── champion_labels.json

scripts/
└── train_champion_classifier.py

docs/
├── SETUP.md             — deeper deployment + self-host guide
└── plans/               — historical design + implementation plans
```

## Releases

New builds are published to [GitHub Releases](https://github.com/danthi123/LoLProxyChat/releases). To cut a release:

```bash
# bump src-tauri/Cargo.toml version
npx tauri build
gh release create v0.1.X src-tauri/target/release/proxchat.exe \
  --title "v0.1.X — short summary" \
  --notes "release notes here"
```

Users can always grab the most recent via:
```
https://github.com/danthi123/LoLProxyChat/releases/latest/download/proxchat.exe
```

## Acknowledgements

- [LeagueMinimapDetectionCNN](https://github.com/Maknee/LeagueMinimapDetectionCNN) — reference code for minimap detection
- [League of Legends Wiki](https://wiki.leagueoflegends.com) — champion circle icon assets used for classifier training
- [Tauri](https://tauri.app) — desktop app framework

## License

[PolyForm Noncommercial 1.0.0](LICENSE) — source available for personal and noncommercial use only.

Champion icon assets from the [League of Legends Wiki](https://wiki.leagueoflegends.com) (CC BY-SA 3.0) were used for model training only and are not distributed with this software.
