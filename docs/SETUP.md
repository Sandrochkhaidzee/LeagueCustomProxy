# LoLProxChat Setup Guide

This is the deeper guide. For a quick start, see the top-level [README](../README.md).

## 1. Run the Client (Most Users)

1. **Set League of Legends to Borderless mode** (Settings → Video → Window Mode → Borderless). This is required — DX9 true fullscreen takes exclusive GPU output and no overlay can render over it.
2. Download `proxchat.exe` from [Releases](https://github.com/danthi123/LoLProxyChat/releases/latest).
3. Run it. The panel appears in the middle of the screen until a game starts, showing the current lifecycle status (e.g. "Waiting for League of Legends", "In champion select", "Joining game...").
4. Once you load into a match the panel jumps to the left edge of the minimap. The transparent region over the minimap is the calibration overlay (purely visual right now — manual drag/resize handles aren't wired up).
5. **Input mode** defaults to **Always Open** (mic always live unless self-muted). Switch to **Push to Talk (F8 hold)** in Settings if preferred. Per-player MUTE buttons mute that specific player for you only.
6. Toggle **Settings → Debug** to visualize the HSV-filtered minimap and tracking dot. Debug mode also exposes a **Scan Rate** slider — default 50 ≈ 30 FPS, max 100 = 60 FPS. Smoothing constants are scan-rate invariant. Debug also writes a log file at `%LOCALAPPDATA%\com.proxchat.app\proxchat.log` (truncated each session) so you can inspect issues without dev tools.

### Global shortcuts (work over LoL when in Borderless)
- `Ctrl+Shift+M` — toggle self-mute
- `F8` (hold) — push-to-talk

### Removal
1. Delete the `proxchat.exe` you downloaded.
2. Delete `%LOCALAPPDATA%\com.proxchat.app\` — contains the WebView2 cache (cookies, localStorage, IndexedDB) and `proxchat.log` if Debug was ever enabled. That's the entire footprint.

By default the client talks to `https://proxchat.dant123.com`. To point at a different server, build from source (see below) with `PROXCHAT_SERVER=https://your-server.example.com` in `.env`.

## 2. Build the Client From Source

### Prerequisites
- [Node.js](https://nodejs.org/) 18+
- [Rust](https://rustup.rs/) (stable)
- Windows 10/11 (cross-compilation is possible but untested)

### Steps

```bash
git clone https://github.com/danthi123/LoLProxyChat.git
cd LoLProxyChat
npm install
cp .env.example .env       # optional — edit PROXCHAT_SERVER if self-hosting
npx tauri build
```

Output: `src-tauri/target/release/proxchat.exe` (~27 MB).

For iterative dev, rebuild and relaunch — there's no `tauri dev` flow because no webpack dev server is configured:
```bash
npx tauri build && src-tauri/target/release/proxchat.exe
```

## 3. Self-Host the Signaling Server

The server replaces what used to be a stack of Supabase containers — it's a single Node process handling WebSocket signaling, AES-GCM position encryption + volume computation, and TURN credential issuance.

### Generate an encryption key

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Save this — it must be the same on every server instance and is the only thing standing between an attacker and seeing decrypted positions.

### Deploy via Docker

`docker-compose.proxchat.yml` at the repo root brings up the server plus a coturn sidecar:

```bash
export ENCRYPTION_KEY=<your-64-hex-key>
export TURN_SERVER=turn.your-domain.com    # optional
export TURN_SECRET=<coturn-shared-secret>  # optional
docker compose -f docker-compose.proxchat.yml up -d
```

The server listens on `:3100`. Front it with a TLS-terminating reverse proxy that supports WebSocket upgrades. Example Caddy block:

```caddy
proxchat.your-domain.com {
  reverse_proxy localhost:3100
}
```

Caddy upgrades WebSockets automatically. For nginx, ensure `proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";`.

### Deploy directly (no Docker)

```bash
cd server
npm install
npm run build
PORT=3100 ENCRYPTION_KEY=<hex> npm start
```

### Verify

```bash
curl https://proxchat.your-domain.com/health
# {"status":"ok","rooms":0}

curl https://proxchat.your-domain.com/turn-credentials
# {"iceServers":[{...}]}
```

WebSocket handshake (should return `101 Switching Protocols`):
```bash
curl -i -H "Connection: Upgrade" -H "Upgrade: websocket" \
     -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGVzdA==" \
     https://proxchat.your-domain.com/ws
```

### TURN server (optional)

For users behind symmetric NAT, set up [coturn](https://github.com/coturn/coturn). The `docker-compose.proxchat.yml` includes a coturn sidecar — supply a `coturn/turnserver.conf` with at least:

```
listening-port=3478
tls-listening-port=5349
use-auth-secret
static-auth-secret=<same as TURN_SECRET env var>
realm=your-domain.com
```

The signaling server's `/turn-credentials` endpoint issues short-lived HMAC credentials so the shared secret never leaves your infrastructure.

## 4. Development Workflow

### Build commands

```bash
npm run build          # webpack — dev build of frontend (sourcemaps, no minify)
npm run build:prod     # webpack — production build of frontend (called by tauri build)
npx tauri build        # full production exe
```

### Tests

```bash
npm test                  # jest — pure-logic core modules
cd server && npm test     # vitest — server room/volume/turn logic
```

### Cutting a Release

```bash
# Bump src-tauri/Cargo.toml:  version = "0.1.X"
npx tauri build
gh release create v0.1.X src-tauri/target/release/proxchat.exe \
  --title "v0.1.X — summary" \
  --notes "what changed"
```

## 5. Train the Champion Classifier (Rare)

The shipped `models/champion_classifier.onnx` covers all current champions. Retrain only when Riot adds new champions or you want to experiment.

```bash
# Requires Python 3.10+, PyTorch, ONNX, Pillow
# Place champion circle icons in assets/champion-circles/<ChampionName>/*.png
python scripts/train_champion_classifier.py
```

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Overlay invisible during gameplay | LoL is in true fullscreen — switch to **Borderless** mode in Video Settings. |
| Overlay sits in middle of screen forever | No game detected, OR CV hasn't locked on yet. Lifecycle text in the panel tells you which phase you're in. |
| Overlay sits above the minimap instead of beside it | `position_overlay` got minimap bounds with wrong dimensions — toggle Debug on and check the tracking-state log line. |
| Overlay is offset slightly from the minimap on a laptop | DPI scaling — should be handled in v0.1.5+. If you're on an older build, update. |
| Per-player MUTE button doesn't visibly react | Should be fixed in v0.1.16+. If still broken, check the panel hit-rect via Debug logs. |
| Audio cuts out / crackles | Almost always main-thread contention from CV at high scan rates. Drop **Scan Rate** to ~50 (30 FPS). v0.1.15+ uses Chromium's native NS which is much more robust than the old RNNoise path. |
| Word starts/ends clipped | DTX issue — fixed in v0.1.14+. If you're on an older build, update. |
| `curl /health` from outside works, but the client times out connecting | Reverse proxy isn't upgrading WebSockets — check proxy config. |
| Peers connect but hear nothing | Confirm both clients are v0.1.7+ (wire-protocol fix). Then check that ICE is connecting — toggle Debug, look for `[WebRTC] ICE state ... : connected`. If it goes to `failed`, peers are behind restrictive NAT and need a working TURN server. |
