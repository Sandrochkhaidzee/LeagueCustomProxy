# Contributing

This is a personal project, but PRs and issues are welcome. This doc is the ground-truth for build / test / release / style. If anything here disagrees with what's checked into the repo, the repo wins — please file an issue.

## Getting set up

Prerequisites:

- [Node.js](https://nodejs.org/) 18+
- [Rust](https://rustup.rs/) (stable toolchain)
- Windows 10/11 with WebView2 Runtime (Windows 11 ships with it; pushed via Edge on Windows 10)

```bash
git clone https://github.com/danthi123/LoLProxChat.git
cd LoLProxChat
npm install
cp .env.example .env       # optional — point at a different signaling server if you want
```

## Common commands

```bash
# Frontend dev build (sourcemaps, no minify)
npm run build

# Frontend production build (called automatically by tauri build)
npm run build:prod

# Full production exe — lands at src-tauri/target/release/lolproxchat.exe
npx tauri build

# Run client tests
npm test

# Run server tests
cd server && npm test
```

There is no `tauri dev` flow — the project doesn't run a webpack dev server. The iterative loop is `npx tauri build && src-tauri/target/release/lolproxchat.exe`, which is fast enough at ~60-90 s for incremental Rust compiles.

## Project layout

See [`docs/architecture.md`](docs/architecture.md) for the system-level view (windows, services, server, TURN, etc.). The relevant directories for contributors:

```
src/
├── background/       — Orchestrator entry point (loaded into the overlay window)
├── overlay/          — Panel window (HTML/CSS/TS) — player list, settings, drag handle
├── scanner/          — Scanner window (HTML/CSS/TS) — click-through overlay over minimap
├── core/             — Pure logic modules (deterministic, fully testable)
└── services/         — Runtime services with side effects (network, audio, CV)

src-tauri/
├── src/              — Rust backend (capture, LCU polling, window positioning, updater)
├── capabilities/     — Tauri 2 ACL grants (drag, event emit/listen)
└── tauri.conf.json   — Window definitions, build config

server/                — Node WebSocket + HTTP signaling server
├── src/              — Rooms, signaling handler, volume math, TURN credential issuance
└── tests/            — vitest unit tests

tests/                 — Client jest tests (separate roots: tests/core, tests/services, tests/integration)
docs/                  — User guide, architecture, self-hosting, threat model, compliance
```

## Code style

- **TypeScript:** strict mode (see `tsconfig.json`). Avoid `as any` outside of well-justified bridging to untyped APIs (Tauri responses, ONNX outputs).
- **Comments:** explain *why* if it's non-obvious, not *what* the code does. Don't reference the current task or commit in code comments — those belong in PR descriptions and CHANGELOG.
- **Logging:** `console.log` is the file-log sink (the `core/logging.ts` layer routes it to the rolling log file when Debug is on). Use `console.warn` for unexpected-but-recoverable, `console.error` for "this should not happen." Don't log per-tick high-frequency events without throttling — see `audio.ts::applyPeerVolumes` for the pattern.
- **Error handling:** no silent catches. If something can fail, log the failure with enough context that a future bug report has something to grep for. Suppress-with-comment is acceptable only when the failure is genuinely non-fatal (e.g., the scanner not being ready yet, or a `hide_scanner` cleanup call during teardown).

## Testing

- **Client tests** live under `tests/` (separate root from `src/`). Run with `npm test`. The 123 tests cover core logic, tracking state machine, audio gain math (slider×proximity, plus `resolveProximityTargets` which silences peers the server drops from range — the v0.3.1 stuck-gain fix), device list filtering, tracking-helper scoring math (composite/jump/hold-cap), the v0.4 template-matching module (NCC + SSIM + best-of-N + crop/resize, in `template-match.ts`) and the Data Dragon champion-name→id resolver (`champion-icons.ts`), the position-jump warning gates, the session-flow integration, the champion-classifier label resolver, the dynamic overlay resize helpers, and the PTT-rebind keymap.
- **Server tests** live under `server/tests/`. Run with `cd server && npm test`. 75 tests cover room management (including v0.3 team + hearCrossTeam fields and v0.2 coords storage), TURN credential generation (both coturn-HMAC and Cloudflare paths), volume math (v0.3 tiered proximity + legacy v0.2 room-state + legacy v0.1 encrypted-blob path), and rate-limiting (`TokenBucket`, `ConcurrencyLimiter`, `clientIp`).
- New features should land with tests where the logic is testable (pure functions, state machines). DOM-heavy or Tauri-IPC-heavy code can skip tests; mock surfaces are too brittle to be worth maintaining.

## Measuring CV tracking accuracy (real data)

Synthetic accuracy metrics don't predict real tracking performance (see [`docs/plans/2026-06-03-cv-tracking-research.md`](docs/plans/2026-06-03-cv-tracking-research.md)) — so the only honest way to evaluate the champion identifier is on real minimap crops harvested from actual games:

1. **Harvest** (opt-in, Debug-only): set `localStorage.setItem('lolproxchat.harvest', 'true')` and turn Debug on, then play games. While the tracker is LOCKED it saves ~1 crop/2s of your champion's icon to `%LOCALAPPDATA%\com.proxchat.app\harvest\<champion>\`. The label (your champion) is reliable ground truth, independent of either identifier. Off by default; zero cost otherwise. (Harvest tooling lands in builds after v0.4.0 — rebuild from `main` to use it.)
2. **Evaluate**: `python scripts/eval_real_crops.py` (needs `scikit-image`). It auto-detects the harvest folder and compares the 172-class ONNX classifier against SSIM template matching on those real crops, reporting top-1 accuracy (full + restricted to the harvested champion pool), mean winning score, and a per-champion breakdown.

## Commit conventions

Loosely [Conventional Commits](https://www.conventionalcommits.org/), used to scan history during release-note drafting:

- `feat:` — user-visible feature
- `fix:` — user-visible bug fix
- `feat(v0.1.X):` — bundled release with multiple changes (used for the version-stamping commit)
- `chore:` — Cargo.lock bumps, dependency updates, repo hygiene
- `docs:` — documentation only
- `ci:` — CI workflow changes
- `refactor:` — non-behavioral code restructuring
- `style:` — formatting / comments only
- `test:` — test additions or fixes
- `diag:` — adding diagnostic logging (no functional change)
- `perf:` — performance improvement

**Do not use auto-close keywords (`closes`, `fixes`, `resolves`) in commit messages or PR descriptions.** Issues stay open until the reporter confirms or the maintainer manually closes them. Use bare `#N` references for traceability.

## Release process

See [`docs/self-hosting.md`](docs/self-hosting.md) § "Cutting a Release" for the full sequence. Short version:

1. Bump `version` in `src-tauri/Cargo.toml`.
2. `npx tauri build`.
3. Commit + tag + push.
4. `gh release create` with SHA-256 hash inlined in the release notes (see the README's Releases section for the exact command).
5. Auto-update clients pick it up on next launch.

## Anti-patterns we've explicitly avoided

These are decisions worth knowing about before proposing a change:

- **Client-side proximity math (with or without per-room E2E encryption)** — would let modified clients read every peer's raw distance vector, which undoes the anti-cheat design. The current model (positions go to the server, server returns only volumes, client never sees another peer's coords) is intentional. v0.2 dropped the server-side AES-GCM blob layer because TLS already covers the wire and the encryption was duplicate work that introduced reliability problems — the anti-cheat guarantee never depended on it. See [`docs/threat-model.md`](docs/threat-model.md).
- **A hosted doc site** — flat markdown in the repo is the right resolution for a project this size. If `docs/` ever sprawls beyond 10-15 files, revisit.
- **Telemetry / analytics** — the project commits to none. If ever added, must be opt-in and visible in Settings. See [`docs/threat-model.md`](docs/threat-model.md) § "What we don't collect".
- **Self-hosted coturn as the default TURN backend** — was the default through v0.1.25; replaced with Cloudflare Realtime TURN in v0.1.26 (server) / docs in v0.1.26+. coturn remains a supported fallback for self-hosters, see [`docs/self-hosting.md`](docs/self-hosting.md).
