# Changelog

All notable changes to LeagueProxy are documented here.

## [2.3.0] — 2026-06-18

### Host app

- Add **Cloudflare (internet)** hosting mode in `server.exe` — managed quick tunnel, auto-filled public HTTPS URL, stops with the signaling server.
- **Direct** vs **Cloudflare** mode selector; optional **cloudflared** path with browse button (or auto-detect on PATH).
- **Share Credentials** / **Copy** — copies `Protocol` / `Host` / `Port` block for friends to paste into the connect screen.
- Fix host **Check for Updates** when `GITHUB_REPOSITORY` has trailing whitespace (baked API URL).
- Fix Cloudflare tunnel URL parsing so status shows only the `trycloudflare.com` URL, not cloudflared log output.

### Docs

- README and friend playbook: Cloudflare hosting instructions.

## [2.2.0] — 2026-06-18

### Updates & connect screen

- Remove startup auto-update — check for updates manually with **CHECK** only.
- Add **Updates** section to the connect screen so players can update before joining a server.
- Fix connect form layout (label overlap and inconsistent field alignment).

### Input

- Fix PTT hotkey swallowing keys while typing in the connect form (e.g. hostnames containing `T`).

## [2.1.0] — 2026-06-17

### Connect & networking

- Fix disconnects when connecting over **HTTPS / Cloudflare quick tunnels** — grace period before health checks and skip probes while the WebSocket is still connecting.
- Use cleaner HTTPS/WSS URLs (omit redundant `:443` / `:80`).

## [2.0.0] — 2026-06-17

Major release: dedicated host app, connect-on-launch flow, and improved tracking.

### Host app

- New **`server.exe`** desktop host (Tauri) — start/stop signaling, copy share URL, no Node.js required.
- Embedded signaling server bundled inside the host app; `scripts/start-server.bat` remains for developers.
- Host admin API with connection event log and live client list.
- GitHub Actions release workflow builds and ships **both** `leagueproxy.exe` and `server.exe`.

### Connect & networking

- **Connect screen** on launch: protocol, host IP, port, and display name (session-only — re-enter each run).
- **Disconnect** to change host without restarting the app.
- No baked-in default server URL; host shares connection details each game night.
- Relay status indicator (TURN vs STUN-only) in settings.

### Voice & audio

- Allies use proximity falloff like enemies (distance-based volume for everyone).
- Refactored volume and transmit-indicator logic with unit tests.
- Audio pipeline cleanup and more reliable LIVE / IDLE indicator.

### Tracking

- Champion **template matcher** for more reliable minimap icon identification.
- Scanner calibration flow and improved blob scoring / jump limits.
- Dynamic overlay resize with DPI-aware height sync.

### App & UI

- New app icons (client + server) generated from `assets/*.png` via `npm run generate:icons`.
- Collapsible panel header; settings gear and close controls.
- Overlay polish: connection status, relay line, calibrate row.

### Developer

- `scripts/build-server.bat` for local `server.exe` builds.
- `webpack.server.config.js` and `dist-server/` frontend for the host app.
- Unit tests for resize, audio volume/transmit, tracking helpers, template-match math, and VAD math.
- CI runs tests and icon generation before Tauri builds.

## [1.0.0] — 2026-06-17

First stable release for custom 5v5 friend groups.

### Voice & audio

- WebRTC voice with proximity-based volume (allies full volume; enemies fade by distance).
- Input modes: **Voice Activation**, **Push-to-Talk**, and **Always Open**.
- LIVE / IDLE transmit indicator based on voice detection (VAD and Always Open).
- AudioWorklet pipeline with mic metering, gain, and optional RNNoise suppression.
- Energy VAD with adjustable sensitivity; optional Silero ML VAD in dev builds.
- Configurable Opus quality, echo cancellation, browser NS, and auto gain.

### App & UI

- Tauri desktop overlay docked beside the minimap.
- Collapsible settings: Input, Output, Audio Processing, Updates.
- Per-player mute and volume; global self-mute and mute-all.
- Manual **Check for Updates** with in-app download and apply.
- Close button to exit the app.

### Tracking

- Minimap computer-vision position tracking with champion classifier.
- Server-side room state and volume computation.

### Host & distribution

- Signaling server in `server/` (run via `scripts/start-server.bat`).
- GitHub Actions release workflow builds `leagueproxy.exe` on version tags.
- Self-hosted signaling server documented in README and friend playbook.

### Developer

- Release vs dev builds (`leagueproxy.exe` vs `leagueproxy-dev.exe`).
- Split build scripts for faster iteration (`build-frontend-only`, `build-rust-only`).

[2.3.0]: https://github.com/Sandrochkhaidzee/LeagueCustomProxy/releases/tag/v2.3.0
[2.2.0]: https://github.com/Sandrochkhaidzee/LeagueCustomProxy/releases/tag/v2.2.0
[2.1.0]: https://github.com/Sandrochkhaidzee/LeagueCustomProxy/releases/tag/v2.1.0
[2.0.0]: https://github.com/Sandrochkhaidzee/LeagueCustomProxy/releases/tag/v2.0.0
[1.0.0]: https://github.com/Sandrochkhaidzee/LeagueCustomProxy/releases/tag/v1.0.0
