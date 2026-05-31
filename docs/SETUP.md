# LoLProxChat Setup Guide

This is the deeper guide. For a quick start, see the top-level [README](../README.md).

## 1. Run the Client (Most Users)

1. Download `proxchat.exe` from [Releases](https://github.com/danthi123/LoLProxyChat/releases/latest).
2. Run it. On first launch you'll see a small panel; it stays empty until you're in a League match.
3. The panel auto-positions left of the minimap once CV locks on. The transparent region over the minimap is the calibration overlay (purely visual right now — manual drag/resize handles aren't wired up yet).
4. Toggle **Settings → Debug** to visualize the HSV-filtered minimap and tracking dot.

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
| Overlay opens in the middle of the screen and never moves | The orchestrator didn't load — check the WebView2 dev console (right-click → Inspect on the overlay) for JS errors |
| Overlay sits above the minimap, doesn't overlap it | `position_overlay` got minimap bounds with wrong dimensions — toggle Debug on and look at the tracking-state line |
| Debug overlay icons stack/smear each frame | The overlay HWND isn't being excluded from capture (Windows < 10 2004) |
| `curl /health` from outside works, but the client times out connecting | Reverse proxy isn't upgrading WebSockets — check proxy config |
| No audio between peers in the same game | Both peers reach signaling but WebRTC ICE fails — check `/turn-credentials` and verify the coturn container is healthy |
