# LeagueProxy

**Beta** — proximity voice for League of Legends custom games with friends.

Download the latest **`leagueproxy.exe`** from [Releases](https://github.com/Sandrochkhaidzee/LeagueCustomProxy/releases).

## Players (3 steps)

1. **Join Radmin VPN** — network name and password from the host (Discord).
2. **Download** `leagueproxy.exe` from Releases → verify SHA-256 in the release notes.
3. **Launch** the exe → open League in **Borderless** mode → join the host’s custom game.

First launch: Windows SmartScreen may warn → **More info → Run anyway**.

No build tools needed. The exe is already pointed at the host server.

## Host (you)

Every game night, before anyone queues:

1. Connect to **Radmin VPN**
2. Run **`scripts\start-server.bat`** (leave the window open)
3. Allow **TCP port 3100** through Windows Firewall (VPN only)
4. Launch **`release\leagueproxy.exe`** and create the custom lobby

## Requirements

| | |
|--|--|
| OS | Windows 10/11 + WebView2 |
| League | **Borderless** window mode (all 10 players) |
| VPN | Radmin VPN — same network as host |
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

Requires Node.js, Rust, and Visual Studio C++ Build Tools. Output: `release\leagueproxy.exe`.

## Attribution

Forked from [LoLProxChat](https://github.com/danthi123/LoLProxChat) by Daniel Thiberge — [AGPLv3](LICENSE).

Champion classifier assets from [Community Dragon](https://www.communitydragon.org/) (Riot IP, training use only).

## Full guide

[docs/friend-playbook.md](docs/friend-playbook.md)
