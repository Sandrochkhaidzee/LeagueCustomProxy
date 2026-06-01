# LoLProxChat

Proximity voice chat for League of Legends. Hear nearby players with volume that scales by in-game distance, tied to minimap vision — if you can't see them, you can't hear them.

Standalone Windows desktop app built with Tauri 2 + WebView2. No Overwolf, no third-party voice service.

## Install

Download the latest `lolproxchat.exe` from [Releases](https://github.com/danthi123/LoLProxChat/releases/latest). It's a single portable executable — no installer.

**Requirements:**
- Windows 10 1809+ or Windows 11
- WebView2 Runtime (ships with Windows 11; pushed via Edge on Windows 10)
- **League of Legends must be set to Borderless mode** (Settings → Video → Window Mode → Borderless). True fullscreen takes exclusive GPU output and no transparent overlay — including this one — can render over it. Borderless is functionally identical performance-wise.

Launch the exe before or during a League match. The overlay auto-attaches beside the minimap once a game is detected.

### Independent malware scan

Every release exe is auto-submitted to [VirusTotal](https://www.virustotal.com/) via a GitHub Action (`.github/workflows/virustotal.yml`) the moment the release is published. A scan permalink for each `.exe` asset gets appended to the release body within ~30 seconds, so you can verify the binary against 70+ antivirus engines before downloading. Look for the **"Virus Total"** section near the bottom of any release page.

### First-run on Windows: SmartScreen warning

The exe isn't code-signed (signing certs are paid + tied to a legal entity, not worth it for a personal open-source project), so the first time you run it Windows will show one of:

- **"Windows protected your PC"** (SmartScreen blue dialog) → click **More info** → **Run anyway**.
- **"This app has been blocked for your protection"** (Mark of the Web from downloaded files) → right-click `lolproxchat.exe` → **Properties** → check **Unblock** at the bottom → **OK** → launch again.

Both prompts are Windows' standard treatment for any unsigned exe downloaded from the internet (Discord standalone, OBS portable, many indie tools all get the same warning the first time). Subsequent launches don't prompt.

If you'd rather audit before running: source is in this repo, build it yourself from `npx tauri build` to skip the warning entirely (locally-built exes don't carry the Mark of the Web).

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

## Compliance with Riot's third-party policy

LoLProxChat is built to stay within the categories Riot Games explicitly publishes as allowed for third-party tools. The mechanisms it uses are the same as Discord's overlay, Mobalytics, Blitz, Porofessor, and similar widely-used apps that have operated continuously alongside League of Legends for years.

**What it does (all in Riot's "allowed" column):**
- Reads the **League Client (LCU) API** for game phase and your summoner identity, and the **Live Client Data API** (`https://127.0.0.1:2999`) for the player roster. Both are interfaces Riot specifically designed for third-party use ([LCU policy](https://www.riotgames.com/en/DevRel/changes-to-the-lcu-api-policy)).
- Captures the **minimap region only** via standard Win32 `BitBlt` (same mechanism as OBS, ShareX, the Snipping Tool). No video frames from the game render path are touched.
- Renders an **overlay window** that paints **outside** the LoL process — never injects, never reads game memory, never hooks DirectX. Riot's own Vanguard FAQ confirms: *"Overlays and internal tools using the API, game client, and in-game APIs should continue to function"* ([Vanguard FAQ](https://www.riotgames.com/en/DevRel/vanguard-faq)).

**What it explicitly does NOT do (the Riot ban triggers):**
- ❌ No game memory reading — Vanguard blocks this, and we never attempt it
- ❌ No process injection, DLL loading, or DirectX hooking
- ❌ No network packet interception, modification, or replay
- ❌ No automation, scripting, or bot behavior — the app never takes any in-game action on your behalf
- ❌ No decision-making aids ("draw conclusions for you") — no enemy ult timers, no warned-by, no jungle timers, no skill suggestions
- ❌ No exposure of obfuscated information — no fog-of-war reveals, no warded-by indicators, no enemy item builds, no spectator-mode data
- ❌ No in-game advertising (banned by Riot in May 2025) — the app shows no ads at all
- ❌ Free + open source — Riot's monetization rules require a free tier; this app has only a free tier

**Specifically the proximity audio:** the volume falloff to zero at ~1200 game units (typical LoL vision range) means by default you only hear enemies who are roughly close enough that the game would already give you visual indicators of their presence (minimap icon when they walk past warded ground, champion model when they enter your vision). The app does not reveal *where* an enemy is — only that one is somewhere within hearing range. This is strictly less information than what Discord voice chat with the same opponent already provides (which has zero distance modulation).

**Riot Developer Portal status:**
LoLProxChat is **registered and approved** on the Riot Developer Portal — **App ID 809090**. The registration documents the LCU + Live Client Data endpoints used and the architectural approach (Tauri overlay, no memory reads, no injection). This is the official sign-off that the app's design fits Riot's allowed-tools category.

**Honest caveats:**
- Riot has **restricted LCU-using apps in Korea** as of the LCU API policy change. The app does not enforce a region check — users in Korean regions should not run it.
- LCU and Live Client Data are officially listed as "unsupported" — Riot can change endpoint shapes anytime, which would break the app (but won't ban users).
- *Nothing here constitutes legal advice or a guarantee against action by Riot.* This section describes the design intent and the published rules, not a contract.

References:
- [League of Legends Third Party Applications policy](https://support-leagueoflegends.riotgames.com/hc/en-us/articles/225266848-Third-Party-Applications)
- [Riot Developer Portal — General Policies](https://developer.riotgames.com/policies/general)
- [Changes to the LCU API Policy](https://www.riotgames.com/en/DevRel/changes-to-the-lcu-api-policy)
- [Vanguard FAQ for Third Party Applications](https://www.riotgames.com/en/DevRel/vanguard-faq)

## Usage

1. Make sure LoL is set to **Borderless** mode (Settings → Video → Window Mode → Borderless).
2. Launch `lolproxchat.exe`. The panel appears in the middle of the screen until a game starts (it'll show the current lifecycle phase — "Waiting for League of Legends", "In champion select", etc).
3. Once you load into a match the panel jumps to the left edge of the minimap (you can drag it anywhere from the title bar). Other players also running LoLProxChat in the same match will appear in the list within a few seconds.
4. **Always Open** mic is the default — just talk and they'll hear you, scaled by in-game distance. Switch to **Push to Talk (F8)** in Settings if you'd prefer.
5. Click **MIC** to self-mute, **VOL** to mute everyone, or the per-row **MUTE** button to silence a specific player.
6. Pick a specific mic / speaker under **Settings → Input Device / Output Device** if Windows' default isn't what you want.

## Reporting bugs

If you hit a bug — voice not working, weird volume, players not appearing, crashes — please open an issue at <https://github.com/danthi123/LoLProxChat/issues> with the debug log attached. The log captures everything the app sees (WebRTC connection state, ICE negotiation, CV tracking, etc) and is by far the fastest way for us to figure out what went wrong.

To grab the log:

1. Open **Settings → Debug**, click **OFF** to flip it to **ON**. (This starts writing diagnostics to disk; it has near-zero overhead.)
2. **Reproduce the bug** — start a game, repeat whatever triggered the issue, etc.
3. Open **Settings → Debug Logs**, click **OPEN**. Explorer pops up at `%LOCALAPPDATA%\com.proxchat.app\` — drag `lolproxchat.log` into your GitHub issue.

The log is plain text. It contains your summoner name and the summoner names of nearby players (gameplay-public), plus technical IP info from WebRTC ICE candidates. If any of that is sensitive in your situation, skim through and redact before posting.

## Uninstall

Because it's a portable exe with no installer, removing it is a two-step process:

1. **Delete the exe** wherever you put it (probably Downloads or a folder you chose).
2. **Delete WebView2 / app data:** `%LOCALAPPDATA%\com.proxchat.app\` — contains the WebView2 cache (cookies, localStorage, IndexedDB) and `lolproxchat.log` if you ever enabled Debug. Open `Run` (Win+R) and paste `%LOCALAPPDATA%\com.proxchat.app\` to find it.

That's the full footprint. No registry entries owned by LoLProxChat itself, no entries under `Programs and Features`, no startup tasks, no services.

## Architecture

```
lolproxchat.exe (Tauri 2)
├── Rust backend          — Win32 screen capture, LCU/Live Client polling, window positioning, global shortcuts
└── WebView2 frontend
    ├── overlay window    — draggable panel UI (player list, settings)
    └── scanner window    — transparent, click-through, auto-pinned over the minimap;
                            renders the CV-filtered debug image and tracking dot when Debug is on

server/                   — Node WebSocket + HTTP signaling server
├── /ws                   — WebSocket upgrade for room join, signaling, presence
├── /compute-volumes      — POST: encrypted position blobs → per-peer volumes
├── /turn-credentials     — GET: ephemeral HMAC TURN credentials
└── /health               — health check
```

The panel and scanner are two separate Tauri windows so the panel can stay free of `WDA_EXCLUDEFROMCAPTURE` (which would otherwise break ShadowPlay / Game Bar capture). The scanner gets that flag only while Debug is on, just long enough to break the HSV-filter capture feedback loop.

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
- `Devices` — localStorage-backed input/output audio device pick, used by `AudioService` when (re-)initializing the mic stream and the shared `AudioContext` output sink
- `Updater` — thin wrapper over the Rust update commands, persists the opt-in toggle in localStorage

**Rust commands** (under `src-tauri/src/`):
- `capture.rs` — `set_capture_bounds`, `capture_minimap` (Win32 GDI BitBlt)
- `lcu.rs` — `check_league_running`, `get_game_state`, `get_live_client_data`, `read_text_file`
- `updater.rs` — `check_for_update` (GitHub Releases API), `download_and_apply_update` (download + spawn-handoff + exit). Handles the `--complete-update <old-path>` startup arg that finishes the in-place binary swap.
- `main.rs` — `position_scanner` / `hide_scanner` (auto-pin the scanner window over the detected minimap region), `set_excluded_from_capture` (toggles `WDA_EXCLUDEFROMCAPTURE` on the scanner when Debug flips), `get_screen_size`, `set_panel_size`, `append_log`, `open_log_folder`. Also runs the cursor-position polling loop that dynamically toggles click-through over non-panel regions (skipped while LMB is held so Windows' native window-drag doesn't tear down mid-move), registers global shortcuts (`Ctrl+Shift+M` toggle self-mute, `F8` push-to-talk), opens the rolling log file at `%LOCALAPPDATA%\com.proxchat.app\lolproxchat.log`, and calls into `updater::handle_complete_update_arg` before Tauri starts.

**Tauri 2 capabilities:** `src-tauri/capabilities/default.json` grants both windows `core:window:allow-start-dragging` plus event emit/listen. Without this file, Tauri 2 silently denies all built-in plugin IPC (drag, etc) even though custom invoke commands keep working — so don't delete it.

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

The portable exe lands at `src-tauri/target/release/lolproxchat.exe`.

For iterative dev, rebuild and relaunch:
```bash
npx tauri build && src-tauri/target/release/lolproxchat.exe
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

If `TURN_SERVER`/`TURN_SECRET` are unset, clients fall back to Google STUN only — fine for most home NAT setups, may fail behind symmetric NAT (corporate, some mobile networks).

`docker-compose.proxchat.yml` at the repo root includes both `server` and a `coturn` sidecar. Front the server with a TLS-terminating reverse proxy (Caddy, nginx, Traefik) that proxies `/` to `:3100` and supports WebSocket upgrades.

**TURN/TURNS:** The coturn entry in the compose is configured to run as root and mount a wildcard cert directory via `${TLS_CERT_DIR}` (per-host env var, never committed). With that set up, TURNS (TLS) on port 5349 works alongside plain TURN on 3478. See `docs/SETUP.md` for the cert mount details, router port-forwarding requirements, and the cron pattern for picking up renewed certs.

### Tests

```bash
cd server && npm test     # vitest — rooms, volumes, turn credentials
npm test                  # jest — core logic (room hashing, proximity, etc)
```

## Project Structure

```
src/
├── background/          — orchestrator entry point (loaded into the overlay window)
├── overlay/             — panel window (HTML/CSS/TS) — player list, settings, drag handle
├── scanner/             — scanner window (HTML/CSS/TS) — click-through overlay over the minimap
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
│   ├── capture.rs       — Win32 BitBlt screen capture
│   ├── lcu.rs           — League Client + Live Client Data APIs
│   └── updater.rs       — GitHub Releases check + in-place exe swap
├── capabilities/
│   └── default.json     — Tauri 2 ACL grant (drag, event emit/listen) for overlay + scanner
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

docker-compose.proxchat.yml  — server + coturn reference compose

models/
├── champion_classifier.onnx
└── champion_labels.json

scripts/                 — training + CV testing utilities
├── train_champion_classifier.py
├── update-champion-icons.js
├── test-cv-pipeline.js
└── ...

docs/
├── SETUP.md             — deeper deployment + self-host guide
└── plans/               — historical design + implementation plans
```

## Releases

New builds are published to [GitHub Releases](https://github.com/danthi123/LoLProxChat/releases). To cut a release:

```bash
# bump src-tauri/Cargo.toml version
npx tauri build
gh release create v0.1.X src-tauri/target/release/lolproxchat.exe \
  --title "v0.1.X — short summary" \
  --notes "release notes here"
```

Users can always grab the most recent via:
```
https://github.com/danthi123/LoLProxChat/releases/latest/download/lolproxchat.exe
```

(Releases ≤ v0.1.20 also published a `proxchat.exe` asset under the same URL for legacy compatibility — the auto-updater's fallback for that name was removed in v0.1.21, so new releases only ship `lolproxchat.exe`.)

**Maintainer one-time setup for VirusTotal scan workflow:** grab a free API key from [virustotal.com](https://www.virustotal.com/gui/my-apikey), then **Settings → Secrets and variables → Actions → New repository secret** named `VT_API_KEY`. The workflow at `.github/workflows/virustotal.yml` will then auto-scan every published release's exe assets and append permalinks to the release body.

## Acknowledgements

- [LeagueMinimapDetectionCNN](https://github.com/Maknee/LeagueMinimapDetectionCNN) — reference code for minimap detection
- [League of Legends Wiki](https://wiki.leagueoflegends.com) — champion circle icon assets used for classifier training
- [Tauri](https://tauri.app) — desktop app framework

## License

[PolyForm Noncommercial 1.0.0](LICENSE) — source available for personal and noncommercial use only.

Champion icon assets from the [League of Legends Wiki](https://wiki.leagueoflegends.com) (CC BY-SA 3.0) were used for model training only and are not distributed with this software.
