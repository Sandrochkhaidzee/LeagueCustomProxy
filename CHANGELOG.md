# Changelog

All notable changes to LeagueProxy are documented here.

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
- Radmin VPN–friendly setup documented in README and friend playbook.

### Developer

- Release vs dev builds (`leagueproxy.exe` vs `leagueproxy-dev.exe`).
- Split build scripts for faster iteration (`build-frontend-only`, `build-rust-only`).

[1.0.0]: https://github.com/Sandrochkhaidzee/LeagueCustomProxy/releases/tag/v1.0.0
