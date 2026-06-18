# LeagueProxy

Proximity voice for League of Legends **custom games** with friends.

Download **`leagueproxy.exe`** from [Releases](https://github.com/Sandrochkhaidzee/LeagueCustomProxy/releases).

## Players (3 steps)

1. **Get connection details** from the host — protocol (HTTP/HTTPS), IP, and port.
2. **Download** `leagueproxy.exe` from Releases → verify SHA-256 in the release notes.
3. **Launch** the exe → enter protocol, host IP, and port → **Connect** → open League in **Borderless** mode → join the host’s custom game.

First launch: Windows SmartScreen may warn → **More info → Run anyway**.

No build tools needed.

## Host (you)

Every game night, before anyone queues:

1. Run **`server.exe`** — pick **Direct (LAN / VPN)** or **Cloudflare (internet)** hosting mode → **Start server**
2. **Copy URL** and share with friends
3. **Direct mode:** allow the **TCP port** through Windows Firewall
4. **Cloudflare mode:** install [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) once (no port forwarding; public URL changes each session)
5. Launch **`leagueproxy.exe`** and create the custom lobby

## Requirements

| | |
|--|--|
| OS | Windows 10/11 + WebView2 |
| League | **Borderless** window mode (all 10 players) |
| Network | Host IP reachable by all players (LAN, VPN, port-forwarded, or Cloudflare tunnel) |
| Use case | Private custom 5v5 with friends only |

## Safety

- Uses Riot-approved APIs + minimap capture only (no memory reads, no injection).
- **No analytics or telemetry.**
- Voice is encrypted WebRTC peer-to-peer; the host signaling server sees summoner names and map coordinates for proximity math — not voice.
- **Not for ranked** or public lobbies. Do not use in Korea.

## Rebuild (developers)

```bat
scripts\build-client.bat
```

Requires Node.js 24+, Rust, and Visual Studio C++ Build Tools. Output: `release\leagueproxy.exe`.

Faster iteration:

| Script | Use when |
|--------|----------|
| `scripts\build-frontend-only.bat` | You changed TS/HTML/CSS only |
| `scripts\build-rust-only.bat` | You changed `src-tauri` only |
| `scripts\build-client-dev.bat` | Dev exe with debug UI (`leagueproxy-dev.exe`) |
| `scripts\build-server.bat` | Host app (`server.exe`) |

## Publish a release

```powershell
git tag v2.0.0
git push origin v2.0.0
```

GitHub Actions builds and attaches `leagueproxy.exe` and `server.exe`. See [docs/PUBLISH.md](docs/PUBLISH.md).

## Attribution

Forked from [LoLProxChat](https://github.com/danthi123/LoLProxChat) by Daniel Thiberge — [AGPLv3](LICENSE).

Champion classifier assets from [Community Dragon](https://www.communitydragon.org/) (Riot IP, training use only).

## Full guide

[docs/friend-playbook.md](docs/friend-playbook.md)
