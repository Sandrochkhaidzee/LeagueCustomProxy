# LoLProxChat Setup Guide

This is the deeper guide. For a quick start, see the top-level [README](../README.md).

## 1. Run the Client (Most Users)

1. **Set League of Legends to Borderless mode** (Settings → Video → Window Mode → Borderless). This is required — DX9 true fullscreen takes exclusive GPU output and no overlay can render over it.
2. Download `lolproxchat.exe` from [Releases](https://github.com/danthi123/LoLProxChat/releases/latest).
3. Run it. The panel appears in the middle of the screen until a game starts, showing the current lifecycle status (e.g. "Waiting for League of Legends", "In champion select", "Joining game...").
4. Once you load into a match the panel jumps to the left edge of the minimap. You can drag it anywhere by grabbing the title bar. A second, separately-positioned scanner window snaps over the minimap itself (transparent + click-through, normally invisible — it only paints when Debug is on).
5. **Input mode** defaults to **Always Open** (mic always live unless self-muted). Switch to **Push to Talk (F8 hold)** in Settings if preferred. Per-player MUTE buttons mute that specific player for you only.
6. **Pick a specific input/output device** under **Settings → Input Device / Output Device**. Defaults to whatever Windows has set as the communications device for each. Selections persist in localStorage. Changing the mic mid-game swaps the source in place without dropping any WebRTC peer connections; changing the output calls `AudioContext.setSinkId` on the existing context.
7. Toggle **Settings → Debug** to visualize the HSV-filtered minimap and tracking dot (drawn into the scanner window). Debug mode also exposes a **Scan Rate** slider — default 50 ≈ 30 FPS, max 100 = 60 FPS. Smoothing constants are scan-rate invariant. Debug also starts writing a log file at `%LOCALAPPDATA%\com.proxchat.app\lolproxchat.log` (truncated each session). The fastest way to grab it: **Settings → Debug Logs → OPEN** pops Explorer at that folder so you can drag `lolproxchat.log` straight into a GitHub issue.

### Global shortcuts (work over LoL when in Borderless)
- `Ctrl+Shift+M` — toggle self-mute
- `F8` (hold) — push-to-talk

### Auto-update

Off by default. Toggle in **Settings → Auto-update**. When on:
1. App checks the GitHub Releases API ~5 s after launch.
2. If `tag_name` is newer than the running version, downloads `lolproxchat.exe` from the release to `<exe-dir>/lolproxchat.exe.new`.
3. Spawns the new binary with `--complete-update <old-path>` and exits.
4. The new process waits ~800 ms (so the old process releases its file lock), deletes the old `.exe` with up to 5 retries, then renames itself from `.exe.new` → `.exe` (renaming a running `.exe` is allowed on Windows; deleting one isn't).

Manual `CHECK` button in Settings works regardless of the toggle. The setting persists via localStorage in the WebView2 user data directory.

### Removal
1. Delete the `lolproxchat.exe` you downloaded.
2. Delete `%LOCALAPPDATA%\com.proxchat.app\` — contains the WebView2 cache (cookies, localStorage, IndexedDB) and `lolproxchat.log` if Debug was ever enabled. That's the entire footprint.

By default the client talks to `https://proxchat.dant123.com`. To point at a different server, build from source (see below) with `PROXCHAT_SERVER=https://your-server.example.com` in `.env`.

## 2. Build the Client From Source

### Prerequisites
- [Node.js](https://nodejs.org/) 18+
- [Rust](https://rustup.rs/) (stable)
- Windows 10/11 (cross-compilation is possible but untested)

### Steps

```bash
git clone https://github.com/danthi123/LoLProxChat.git
cd LoLProxChat
npm install
cp .env.example .env       # optional — edit PROXCHAT_SERVER if self-hosting
npx tauri build
```

Output: `src-tauri/target/release/lolproxchat.exe` (~27 MB).

For iterative dev, rebuild and relaunch — there's no `tauri dev` flow because no webpack dev server is configured:
```bash
npx tauri build && src-tauri/target/release/lolproxchat.exe
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

### TURN server (recommended for WAN-to-WAN)

For users behind symmetric NAT (common on mobile networks, some corporate setups), peers need a TURN relay to talk to each other. The `docker-compose.proxchat.yml` includes a coturn sidecar.

#### Minimal turnserver.conf

```
listening-port=3478
fingerprint
lt-cred-mech
use-auth-secret
static-auth-secret=<same value as TURN_SECRET env var>
realm=your-domain.com
server-name=turn.your-domain.com
external-ip=<your-public-ip>
min-port=49152
max-port=49252
no-multicast-peers
no-cli
```

Router-side: forward UDP 3478 (TURN/STUN) and the UDP relay range (49152-49252 here) to the coturn host.

The signaling server's `/turn-credentials` endpoint issues short-lived HMAC credentials so the static auth secret never leaves your infrastructure.

#### TURNS (TLS, optional but recommended)

TURNS protects credentials in transit, looks like generic HTTPS to firewalls, and helps users on restrictive corporate networks connect. If you already run Caddy / nginx-proxy-manager / Traefik with a wildcard cert for your domain, you can mount the cert dir into coturn:

1. Set `TLS_CERT_DIR=/path/to/dir/containing/wildcard.crt-and-.key` in a local `.env` next to the compose file (the compose references `${TLS_CERT_DIR}`; the `.env` is **not** committed).
2. Append to `turnserver.conf`:
   ```
   tls-listening-port=5349
   cert=/certs/wildcard_.your-domain.com.crt
   pkey=/certs/wildcard_.your-domain.com.key
   ```
   Filenames must match what's in `${TLS_CERT_DIR}`.
3. Forward TCP 5349 on your router.
4. **Cert renewal:** TLS-terminating reverse proxies (Caddy, etc) auto-renew certs but coturn caches them at startup. Schedule a nightly restart so renewed certs get picked up:
   ```
   17 4 * * * /usr/bin/docker restart proxchat-coturn >/dev/null 2>&1
   ```
   A few seconds of TURNS downtime each night; users mid-call are very unlikely to notice.

#### Verifying TURNS works

```bash
echo "" | openssl s_client -connect turn.your-domain.com:5349 \
  -servername turn.your-domain.com 2>&1 | grep -E "subject=|issuer=|Verification"
# Expect:
#   subject=CN=*.your-domain.com
#   issuer=...Let's Encrypt...
#   Verification: OK
```

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
SHA=$(sha256sum src-tauri/target/release/lolproxchat.exe | awk '{print $1}')
gh release create v0.1.X src-tauri/target/release/lolproxchat.exe \
  --title "v0.1.X — summary" \
  --notes "what changed

## Verify download

\`\`\`
SHA-256: $SHA
\`\`\`

- Windows PowerShell: \`Get-FileHash lolproxchat.exe\`
- WSL / git-bash:     \`sha256sum lolproxchat.exe\`"
```

The hash gives users a way to verify the download matches the official build (defense against typosquatting / in-transit tampering / mirror reposts).

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
| Overlay sits above the minimap instead of beside it | `position_scanner` got minimap bounds with wrong dimensions — toggle Debug on and check the tracking-state log line. (The panel window itself never auto-positions; only the scanner does.) |
| Can't drag the panel via the title bar | `src-tauri/capabilities/default.json` is missing or doesn't grant `core:window:allow-start-dragging` — Tauri 2 silently denies built-in IPC without a capability grant. Pre-v0.1.21 builds had this bug. |
| Overlay is offset slightly from the minimap on a laptop | DPI scaling — should be handled in v0.1.5+. If you're on an older build, update. |
| Per-player MUTE button doesn't visibly react | Should be fixed in v0.1.16+. If still broken, check the panel hit-rect via Debug logs. |
| Audio cuts out / crackles | Almost always main-thread contention from CV at high scan rates. Drop **Scan Rate** to ~50 (30 FPS). v0.1.15+ uses Chromium's native NS which is much more robust than the old RNNoise path. |
| Word starts/ends clipped | DTX issue — fixed in v0.1.14+. If you're on an older build, update. |
| `curl /health` from outside works, but the client times out connecting | Reverse proxy isn't upgrading WebSockets — check proxy config. |
| Peers connect but hear nothing | Confirm both clients are v0.1.7+ (wire-protocol fix). Then check that ICE is connecting — toggle Debug, look for `[WebRTC] ICE state ... : connected`. If it goes to `failed`, peers are behind restrictive NAT and need a working TURN server. |
