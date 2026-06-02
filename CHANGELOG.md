# Changelog

All notable changes to this project are documented here. Format adapted from [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow [SemVer](https://semver.org/) loosely — `0.x.y` releases may break compatibility without warning.

## [Unreleased]

## [v0.1.32] — 2026-06-02

### Fixed
- **Per-row volume slider now respects real proximity.** Moving the slider used to immediately play the peer at `slider × 1.0` (hardcoded proximity) before the next 100 ms position tick dropped them back to whatever proximity actually was. Caused a fraction-of-a-second blip of audible playback on each slider movement even when the peer was supposed to be silent. The slider now reads the last server-returned proximity volume from `lastProximityVolumes` and applies on top of it. (`#7`)

### Changed
- **Server: `BLOB_MAX_AGE_MS` widened from 10 s to 30 s.** The L7 logging added in v0.1.31 confirmed that even modest Windows-clock drift (~10-15 s, surprisingly common in the wild) was causing the server to reject every position blob from one user in a session, breaking proximity audio asymmetrically with no obvious failure at the connection layer. 30 s absorbs typical drift; the security tradeoff is a longer replay window for captured blobs, but the volume side-channel is already coarsened by quantization + jitter (v0.1.26).

### Added
- `computeFinalPeerVolume(proximity, slider)` exported from `audio.ts` as a pure helper so the slider math is unit-testable without spinning up AudioService + PeerConnection + WebAudio.
- 6 new tests for the helper (`tests/services/audio.test.ts`): clamping, proximity-0 always-silent, slider-0 always-silent, identity. Client tests now 68 (was 62).

## [v0.1.31] — 2026-06-02

### Security
- **Closed: updater URL injection (H1).** `download_and_apply_update` now refuses any URL that doesn't start with the GitHub release-asset prefix for this repo (`https://github.com/danthi123/LoLProxChat/releases/download/`). Without this check, a compromised frontend could have called the command with an attacker-controlled URL → download + spawn arbitrary binary → full RCE on the user's machine. See [`docs/threat-model.md`](docs/threat-model.md) Part 2 § Update flow.
- **Closed: arbitrary file read (H2).** Renamed `read_text_file(path)` → `read_league_config_file()`. The new command takes no arguments; the path is computed Rust-side from `find_league_install_dir()` and reads only `Config/game.cfg`. Removes the arbitrary-file-read primitive that the frontend used to inherit.

### Added
- `server/src/rate-limit.ts` — in-memory token-bucket + per-IP concurrency limiter. No external dep; ~150 LOC. 13 new server tests (`server/tests/rate-limit.test.ts`).
- `server/src/index.ts` and `server/src/ws-handler.ts` wired through the new limiters: per-IP rate limiting on `/turn-credentials` (60/min) and `/compute-volumes` (15/sec sustained, 30 burst); 256 KB body cap on `/compute-volumes`; WebSocket `maxPayload` 64 KB, 20 concurrent connections per IP, 60 msg/sec sustained per connection. Total server tests now 46 (was 33).
- Clock-skew rejections in `decryptPosition` now emit a structured `[volumes]` warn line with the actual blob age. Was silently returning null, which masked some intermittent voice-issue reports.

### Changed
- `lcu::read_text_file` removed from the Tauri command surface; superseded by `lcu::read_league_config_file`. Sole caller (`Orchestrator.readMinimapScale`) updated to use the new command; the `leagueConfigPath` field on `Orchestrator` is gone.

## [v0.1.30] — 2026-06-02

### Changed
- `[Tracking] WARN: position jumped …` now requires both a distance threshold (>500 game-units) AND the existing speed threshold (>2000 u/s) to fire. Previously the speed-only gate produced ~100 false-positive warnings per 5-minute session of normal play (CV pixel-jitter on a stationary champion at high scan rates registered as 2000+ u/s instantaneously). Real recall / teleport / mis-track events still warn.
- Promoted the warn thresholds to named `JUMP_WARN_MIN_UNITS` / `JUMP_WARN_MIN_SPEED` static constants on `TrackingService` for tunability and grep-ability.

### Added
- Two new test cases in `tracking.test.ts` pin the new gating: pixel-jitter at high scan rate now correctly stays silent, and a large-but-slow movement (600 units over 1.5 s) confirms the speed gate still works.

## [v0.1.29] — 2026-06-02

### Changed
- **Internal refactor — no user-visible behavior change.** `TrackingService.handleLocked` reduced from 158 lines to ~65 lines of orchestration. Pure scoring/selection math extracted to a new `src/services/tracking-helpers.ts` module (`computeMaxJumpPx`, `computeReacquireThreshold`, `computeBlobScore`, `pickBestBlobInRange`, `pickClassifierReacquisition`). The phase-2 and phase-1 success paths split into named methods (`acquireViaClassifier`, `finalizeLockedFrame`) so the side-effect ordering is explicit. State-mutation ordering preserved; the 42 pre-existing tracking/audio/devices tests still pass against the refactor.
- Extracted the `Blob` interface to its own `src/services/blob-types.ts` so the pure helpers can import it without reaching back into `tracking.ts`.

### Added
- 19 new unit tests for the extracted helpers, covering boundary conditions the inline code never had isolated coverage for: jump-radius minimums, hold-expansion math, stationary-vs-hold threshold interaction, classifier-on-vs-off scoring symmetry, jump-range exclusion. Total client tests now 61.
- `src/core/window-globals.ts` — typed `declare global { interface Window { … } }` for the two app-specific properties used as an ad-hoc cross-module bus. Removes the 4 `(window as any).foo` casts that existed in `overlay.ts`, `background.ts`, and `orchestrator.ts`.

### Removed
- All 7 `as any` casts in `src/` source code. Remaining 5 casts are in `tests/` only (legitimate test-environment mocks and private-method reflection). Dropped 3 vestigial `(console as any).debug` casts in `core/logging.ts` — `console.debug` has been in TS's standard `Console` interface for years.

## [v0.1.28] — 2026-06-02

### Added
- Client-side test coverage for `nextSmoothedVolume` (peer-connection EMA), `setLastPosition` jump-warning behavior (tracking), and `listAudioDevices` synthetic-entry filtering (devices). 42 client tests across 7 files.

### Changed
- Extracted `nextSmoothedVolume` from `PeerConnection.setVolume` as a pure function at module scope so the EMA math can be unit-tested without instantiating a real `RTCPeerConnection`.

### Fixed
- Autoplay-blocked path in `PeerConnection.tryPlay` now logs the peer name and rejection reason instead of swallowing the error silently. Both the initial attempt and the user-gesture retry are visible in debug logs.

### Removed
- `src/core/proximity.ts` and its test — dead client-side proximity math that disagreed with the (now authoritative) server quadratic + bucketed falloff. Footgun for any future code that might have re-imported it.
- `src/core/types.ts::MAX_HEARING_RANGE` — only referenced by the deleted proximity module.
- `src/core/template-match.ts` (~112 lines) and its test — leftover from a pre-classifier CV iteration. Zero callers.
- `src/services/updater.ts::applyUpdateWhenSafe` — uncalled export.
- `src/services/orchestrator.ts::captureCalibrationData` and `resolveLeagueConfigPath` — uncalled dead methods. Both bore stale TODO comments; the install-path one is already solved at session-start via `get_league_install_dir`.

### Security
- Resolved 8 CVEs (1 critical) in `onnxruntime-web`'s transitive `protobufjs` dependency. `npm audit --omit=dev` now reports zero vulnerabilities. Remaining moderate audit findings are in dev-only deps (`jimp`) and don't ship in the exe.

## [v0.1.27] — 2026-06-02

### Added
- `Settings → Hide IP (Force TURN)` toggle. Sets `iceTransportPolicy: 'relay'` on new peer connections so peers never see the user's public IP — voice routes through the TURN relay instead of direct P2P. Default off; adds ~20-100 ms latency.
- `docs/threat-model.md` Part 2: user-facing threat coverage (public IP exposure, server-operator trust, summoner-name visibility, code-signing absence, WebView2 trust, signaling presence enumeration, voice-in-transit). Plus a "what we don't collect" baseline (no analytics, telemetry, fingerprinting, or persistent user IDs).

## [v0.1.26] — 2026-06-02

### Changed
- HSV-filtered minimap debug image moved off the scanner window into a thumbnail in the Settings panel. Eliminates the capture-feedback loop that previously required `WDA_EXCLUDEFROMCAPTURE`.
- Server-side volume math quantized into 5 buckets (`0`, `0.20`, `0.45`, `0.75`, `1.0`) with ±5% multiplicative jitter. Reduces the precision a modified client can extract from continuous volume values. Audio quality unchanged — client EMA still smooths bucket transitions.
- Signaling server now defaults to Cloudflare Realtime TURN. Self-hosted coturn remains supported as a documented fallback.

### Fixed
- ShadowPlay, Nvidia Game Bar, and OBS now capture the app correctly regardless of Debug state (`#2`). `WDA_EXCLUDEFROMCAPTURE` removed entirely.

### Added
- SHA-256 hash of each release exe included in the release body going forward. Per-OS verification commands inlined for ease.
- `docs/threat-model.md` covering cheat / information-leak threats and the rationale behind current calibration.

## [v0.1.25] — 2026-06-02

### Added
- Rolling log retention: keep last 3 sessions (`lolproxchat.log` / `.1.log` / `.2.log`). Restarting the app no longer wipes a session's diagnostics (`#9`).

### Changed
- Verbose `applyPeerVolumes` log throttled to 1 Hz or on summary change (was 10× per second).
- Default `targetVolume` in `PeerConnection` set to 0 instead of 1. Fixes "hear peer at full volume across the map" during the SCANNING phase when the orchestrator's passthrough only sets ally volumes.

## [v0.1.24] — 2026-06-02

### Added
- Auto-recover from WebRTC ICE failure. Initiator re-issues an offer with `iceRestart: true` on `connectionState === 'failed'`. Capped at 2 attempts per peer; counter resets on successful re-connect.
- Per-peer `getStats()` snapshot every 10 s logged in debug mode (connection state, ICE state, selected candidate pair with IP/port/type, RTT, bytes sent/received, packets lost).

### Changed
- `extrapolatePosition` caps velocity magnitude at 10 px/tick before applying. Prevents the runaway where a single CV jump could drift the tracked position 12000 game-units in 500 ms.

### Fixed
- Closing any window now exits the app cleanly (`#8`). Previously closing the panel left the click-through scanner window orphaned over the minimap.

## [v0.1.23] — 2026-06-01

### Added
- `[Tracking] WARN` log when local position changes faster than 2000 game-units/sec — catches CV mis-tracking events that previously had to be inferred from raw position dumps.
- Explicit log line when a peer is created via incoming WebRTC offer (previously only the "Peer joined" path logged the connection).

### Changed
- Per-peer volume EMA alpha capped at 0.3 so even long silent gaps ramp in over multiple ticks instead of snapping to a loud value.

## [v0.1.22] — 2026-06-01

### Added
- Mic and speaker device picker (`Settings → Input Device / Output Device`), persisted to localStorage. Input changes swap the WebAudio source in place — no WebRTC renegotiation needed. Output uses `AudioContext.setSinkId`. (`#6`)
- `Settings → Debug Logs → OPEN` launches Explorer at `%LOCALAPPDATA%\com.proxchat.app\` for one-click log access.

### Changed
- Log file renamed `proxchat.log` → `lolproxchat.log` for post-rename consistency.

## [v0.1.21] — 2026-06-01

### Added
- `src-tauri/capabilities/default.json` granting `core:window:allow-start-dragging` + event emit/listen. Tauri 2 silently denies built-in plugin IPC without an explicit capability — this is why title-bar drag never worked before.
- Mute / mute-all toggles persisted on `Orchestrator` so they survive between sessions and stay stable when toggled outside an active game.

### Changed
- Scanner window split out from the panel. Panel is the draggable UI; scanner is a separate transparent click-through window auto-pinned over the minimap.
- Panel cursor-position polling loop skips the click-through toggle while LMB is held so Windows' native window-drag doesn't get torn down mid-move.

### Removed
- Legacy `proxchat.exe` asset fallback in the auto-updater. New releases ship only `lolproxchat.exe`.

## [v0.1.20] — 2026-06-01

### Fixed
- ShadowPlay no longer turns off when the app is running (first-pass fix; full resolution arrived in v0.1.26).
- Detects League installed outside the default `C:/Riot Games/...` directory via the LCU lockfile path.
- Window drag works in some configurations (first attempt; capability-based fix landed in v0.1.21).

## [v0.1.19] — 2026-06-01

### Added
- Riot Developer Portal application approved (App ID 809090). README compliance section updated.

## [v0.1.18] and earlier

Initial public iteration: Overwolf → Tauri 2 migration, Supabase-stack → custom 1-container WebSocket signaling server, minimap CV pipeline (HSV color filter + blob detection + ONNX champion classifier), WebRTC P2P voice with AES-GCM encrypted position blobs computed server-side, in-app updater. See `docs/plans/` for the historical design + implementation documents from that period.

[Unreleased]: https://github.com/danthi123/LoLProxChat/compare/v0.1.32...HEAD
[v0.1.32]: https://github.com/danthi123/LoLProxChat/releases/tag/v0.1.32
[v0.1.31]: https://github.com/danthi123/LoLProxChat/releases/tag/v0.1.31
[v0.1.30]: https://github.com/danthi123/LoLProxChat/releases/tag/v0.1.30
[v0.1.29]: https://github.com/danthi123/LoLProxChat/releases/tag/v0.1.29
[v0.1.28]: https://github.com/danthi123/LoLProxChat/releases/tag/v0.1.28
[v0.1.27]: https://github.com/danthi123/LoLProxChat/releases/tag/v0.1.27
[v0.1.26]: https://github.com/danthi123/LoLProxChat/releases/tag/v0.1.26
[v0.1.25]: https://github.com/danthi123/LoLProxChat/releases/tag/v0.1.25
[v0.1.24]: https://github.com/danthi123/LoLProxChat/releases/tag/v0.1.24
[v0.1.23]: https://github.com/danthi123/LoLProxChat/releases/tag/v0.1.23
[v0.1.22]: https://github.com/danthi123/LoLProxChat/releases/tag/v0.1.22
[v0.1.21]: https://github.com/danthi123/LoLProxChat/releases/tag/v0.1.21
[v0.1.20]: https://github.com/danthi123/LoLProxChat/releases/tag/v0.1.20
[v0.1.19]: https://github.com/danthi123/LoLProxChat/releases/tag/v0.1.19
