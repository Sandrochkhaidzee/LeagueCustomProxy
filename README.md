# LoLProxChat

![Server status](https://img.shields.io/website?url=https%3A%2F%2Fproxchat.dant123.com%2Fhealth&label=server&up_message=online&down_message=offline)
[![Latest release](https://img.shields.io/github/v/release/danthi123/LoLProxChat)](https://github.com/danthi123/LoLProxChat/releases/latest)
[![License: PolyForm Noncommercial 1.0.0](https://img.shields.io/badge/license-PolyForm--NC--1.0-blue)](LICENSE)

**Proximity voice chat for League of Legends.** Hear nearby players (allies *and* enemies) with volume that scales by in-game distance, tied to minimap vision — if you can't see them, you can't hear them.

Standalone Windows desktop app built with Tauri 2 + WebView2. No Overwolf, no third-party voice service, no telemetry. Registered + approved on the Riot Developer Portal (App ID 809090).

---

## Install

Download the latest `lolproxchat.exe` from [Releases](https://github.com/danthi123/LoLProxChat/releases/latest). Single portable executable — no installer.

**Requirements:**

- Windows 10 1809+ or Windows 11
- WebView2 Runtime (ships with Windows 11; pushed via Edge on Windows 10)
- **League of Legends in Borderless mode** (Settings → Video → Window Mode → Borderless). Required — DX9 true fullscreen takes exclusive GPU output and no transparent overlay can render over it.

Launch the exe before or during a League match. The panel auto-attaches beside the minimap once a game is detected.

### First run

Windows will show one of these on first launch (the exe isn't code-signed; this is the standard treatment for any unsigned binary downloaded from the internet):

- **"Windows protected your PC"** (SmartScreen) → **More info** → **Run anyway**.
- **"This app has been blocked for your protection"** (Mark of the Web) → right-click `lolproxchat.exe` → **Properties** → check **Unblock** → **OK** → re-launch.

Subsequent launches don't prompt.

### Verify your download

Every release body includes a SHA-256 hash. Compare it against your downloaded exe to confirm you got the official build (defends against in-transit tampering, mirror reposts, typosquatted re-uploads):

```bash
# PowerShell
Get-FileHash lolproxchat.exe

# WSL / git-bash
sha256sum lolproxchat.exe
```

Every release exe is also auto-submitted to [VirusTotal](https://www.virustotal.com/) via a GitHub Action. Scan permalinks land in the release body within ~30 seconds of publish — verifiable against 70+ antivirus engines before downloading.

---

## Quick start

1. Make sure LoL is in **Borderless** mode.
2. Launch `lolproxchat.exe`. The panel appears in the middle of the screen showing the current lifecycle ("Waiting for League of Legends", "In champion select", etc.).
3. Once you load into a match, the panel jumps to the left edge of the minimap. Other players running LoLProxChat in the same match appear within a few seconds.
4. **Always Open mic** is the default — just talk. **MIC** = self-mute, **VOL** = mute everyone, **MUTE** per row = silence a specific player.

For the rest — every Settings toggle, troubleshooting, log-grab flow, uninstall — see the **[user guide](docs/user-guide.md)**.

---

## Docs

| Doc | When to read |
|---|---|
| [User guide](docs/user-guide.md) | Day-to-day usage, every Settings toggle, troubleshooting, reporting bugs |
| [Architecture](docs/architecture.md) | How it actually works — CV pipeline, WebRTC flow, server design |
| [Threat model](docs/threat-model.md) | What the design protects, what it doesn't, what we collect (and what we don't) |
| [Compliance](docs/compliance.md) | Relationship to Riot's third-party policy + Developer Portal status |
| [Self-hosting](docs/self-hosting.md) | Run your own signaling server |
| [Contributing](CONTRIBUTING.md) | Build, test, release flow + code style |
| [Security policy](SECURITY.md) | How to report vulnerabilities |
| [Changelog](CHANGELOG.md) | What changed in each release |

---

## How it works (in 5 bullets)

1. **Game detection** — reads the LCU and Live Client Data APIs for game phase + player roster. No memory reads, no injection.
2. **Position** — Win32 BitBlt of the minimap region + HSV color filter + blob detection locates champion icons; since v0.4 each blob is identified by **SSIM template matching** against the 10 actual champion icons in your game (fetched from Riot's Data Dragon at game start), with the older ONNX classifier kept only as an offline fallback. Position is in game coordinates.
3. **Signaling** — players in the same match join a deterministic WebSocket room (room ID = hash of sorted player names) on a self-hosted Node server.
4. **Voice** — WebRTC peer-to-peer audio between players (Opus 128 kbps, DTLS-SRTP). No audio touches any server.
5. **Proximity volume** — each client streams its XY coordinates to the signaling server (over the same WebSocket used for presence/signaling); the server computes pairwise volumes for everyone in the room. Since v0.3: **team voice is always full volume** (no proximity), **cross-team voice is capped at ~600 game units** (auto-attack range) by default — Settings has a toggle to extend it to ~1200 (champion vision range). Server-enforced — a modified client cannot bypass the team filter or range cap. Clients only ever receive `{ peerName: volume }`, never another peer's raw position.

For depth, see [`docs/architecture.md`](docs/architecture.md).

---

## Privacy + anti-cheat in one paragraph

LoLProxChat collects **no analytics, no telemetry, no fingerprinting, no persistent user identifiers**. The only data that leaves your machine is your summoner name (for room routing — same name visible on the match scoreboard), your XY position (sent to the server over TLS, held in process memory only for as long as you're in the room, never logged), WebRTC signaling, and the voice audio itself (DTLS-SRTP, peer-to-peer, never touches the server). Want to keep your public IP private even from peers in your match? **Settings → Hide IP (Force TURN)** routes voice through the TURN relay. See [`docs/threat-model.md`](docs/threat-model.md) for the full breakdown.

---

## License

[PolyForm Noncommercial 1.0.0](LICENSE) — source available for personal and noncommercial use only.

Champion icon assets from the [League of Legends Wiki](https://wiki.leagueoflegends.com) (CC BY-SA 3.0) were used for model training only and are not distributed with this software.

---

## Acknowledgements

- [LOL_Minimap_Tracker](https://github.com/Quinntana/LOL_Minimap_Tracker) — the SSIM template-matching approach the v0.4 champion tracker is based on
- [LeagueMinimapDetectionCNN](https://github.com/Maknee/LeagueMinimapDetectionCNN) — reference code for minimap detection
- [League of Legends Wiki](https://wiki.leagueoflegends.com) — champion icon assets used to train the ONNX classifier (retained only as an offline fallback since v0.4; primary tracking now matches Riot Data Dragon icons)
- [Tauri](https://tauri.app) — desktop app framework
- Cloudflare Realtime TURN — managed TURN relay infrastructure
- Every user who's filed an issue or attached a log — your reports made this app actually work.
