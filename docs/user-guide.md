# User Guide

Everything you need to use LoLProxChat day-to-day. For installation, see the [README](../README.md). For privacy and the threat model, see [`threat-model.md`](threat-model.md). For self-hosting the signaling server, see [`self-hosting.md`](self-hosting.md).

## First-time setup

1. **Set League of Legends to Borderless mode** (Settings → Video → Window Mode → Borderless). This is non-negotiable — DX9 true fullscreen takes exclusive GPU output and no overlay (including this one) can render over it. Borderless is functionally identical performance-wise.
2. Launch `lolproxchat.exe`. The panel appears in the middle of the screen showing the current lifecycle status: "Waiting for League of Legends", "In champion select", "Joining game…", etc.
3. Once you load into a match the panel jumps to the left edge of the minimap. You can drag it anywhere by grabbing the title bar.
4. Other players running LoLProxChat in the same match appear in the player list within a few seconds.

## Panel controls

| Button | What it does |
|---|---|
| **MIC** | Toggle self-mute (no one hears you) |
| **VOL** | Mute everyone for you (you hear no one) |
| **SET** | Open / close the Settings panel |
| **»** | Collapse the panel to a thin column |

Each player row has:

- **Champion name** (or summoner name on hover)
- **Per-player volume slider** — adjust how loud this specific player is for you
- **MUTE button** — silence this specific player without affecting others

## Settings

| Setting | What it does |
|---|---|
| **Input Device** | Which microphone to use. "Default" follows Windows' default communications device. Selection persists across launches. Switching mid-game swaps the source in place — no peer reconnection needed. |
| **Output Device** | Which speaker / headset to send voice to. Same persistence behavior. |
| **Input Mode** | "Always Open" (default) — mic is always live unless self-muted. "Push to Talk (F8)" — hold F8 to transmit. (Note: F8 currently only fires from outside an active game window. See [issue #1](https://github.com/danthi123/LoLProxChat/issues/1).) |
| **Mic Volume** | Pre-transmission gain on your mic, 0-100%. Useful if your hardware mic is too quiet or too hot. |
| **Hide IP (Force TURN)** | Routes all voice through the TURN relay so peers in your match never see your public IP. Defends against DDoS / port-scan attempts from random players. Adds ~20-100 ms latency. Default off; takes effect on the next peer connection. See [`threat-model.md`](threat-model.md) for the full discussion. |
| **Debug** | Toggles diagnostic mode — paints the HSV-filtered minimap and the tracking dot, exposes the Scan Rate slider, and starts writing a debug log to disk. Off by default; turn on only when investigating a problem or asked by a maintainer. |
| **Debug Logs → OPEN** | Launches Explorer at `%LOCALAPPDATA%\com.proxchat.app\` so you can grab `lolproxchat.log` to attach to a GitHub issue. |
| **Auto-update** | When on, the app checks GitHub Releases ~5 seconds after launch and applies any newer version automatically (process exits cleanly, new binary takes over, old one is deleted). Off by default. The setting persists. |
| **Updates → CHECK** | Force an immediate update check, regardless of the Auto-update toggle. |
| **Scan Rate** *(Debug only)* | CV scan rate — 0 ≈ 1 FPS, 50 ≈ 30 FPS, 100 = 60 FPS. Smoothing constants are scan-rate invariant. Drop this if you see audio crackling under heavy CV load (rare on modern hardware). |

## Global keyboard shortcuts

These work even while LoL has focus, *provided LoL is in Borderless mode*:

- **Ctrl+Shift+M** — toggle self-mute
- **F8** *(hold)* — push-to-talk (only effective when **Input Mode** is set to "Push to Talk")

## Reporting bugs

If something's broken — voice not working, weird volume, players not appearing, crashes — please open an issue at <https://github.com/danthi123/LoLProxChat/issues> with the debug log attached. The log captures everything the app sees (WebRTC connection state, ICE negotiation, CV tracking, etc.) and is by far the fastest way to figure out what went wrong.

### Three-step log grab

1. **Settings → Debug** — flip from **OFF** to **ON**. Diagnostic writes start immediately; overhead is negligible.
2. **Reproduce the bug.** Start a game, repeat whatever triggered the issue.
3. **Settings → Debug Logs → OPEN.** Explorer pops up at `%LOCALAPPDATA%\com.proxchat.app\`. Drag `lolproxchat.log` into your GitHub issue.

> If you restarted the app between the bug and grabbing the log, the previous session is at `lolproxchat.1.log`. The app keeps three rolling sessions: `.log` (current) → `.1.log` (previous) → `.2.log` (oldest).

The log is plain text. It contains your summoner name and nearby players' summoner names (gameplay-public), plus technical IP info from WebRTC ICE candidates. If any of that is sensitive in your situation, skim through and redact before posting.

## Troubleshooting

| Symptom | Most likely cause |
|---|---|
| Overlay invisible during gameplay | LoL is in true fullscreen. Switch to **Borderless** in Video Settings. |
| Overlay sits in middle of screen forever | No game detected, OR CV hasn't locked on yet. The panel's lifecycle text tells you which phase you're in. |
| Overlay sits above the minimap instead of beside it | Detected minimap bounds are wrong. Toggle Debug on and check the `[Tracking]` log lines. (Note: the *panel* never auto-positions; only the scanner overlay does.) |
| Can't drag the panel via the title bar | You're on a pre-v0.1.21 build. Update — the Tauri 2 capability grant for drag was missing. |
| MIC / VOL toggles revert on their own a few seconds after clicking | You're on a pre-v0.1.21 build. Update. |
| Audio cuts out / crackles | Usually main-thread contention from CV at high scan rates. Drop the **Scan Rate** slider to ~50 (30 FPS). |
| Word starts/ends sound clipped | DTX issue — fixed in v0.1.14+. Update. |
| Peers connect but you hear nothing | Confirm both clients are v0.1.7+ (wire-protocol fix). Then check WebRTC ICE state with Debug on — look for `[WebRTC] ICE state ... : connected`. If it goes to `failed`, peers are behind restrictive NAT and need TURN. |
| ShadowPlay / OBS / Game Bar can't see the app UI | You're on a pre-v0.1.26 build. Update — `WDA_EXCLUDEFROMCAPTURE` was removed entirely. |
| Logs get wiped when you restart the app | You're on a pre-v0.1.25 build. Update — the app now keeps three rolling sessions instead of truncating. |

## Updating

If **Auto-update** is on (Settings), the app downloads and applies new releases automatically on launch.

You can also force a check at any time via **Settings → Updates → CHECK**. If an update is available it downloads and applies immediately; if not you get an "Up to date" message.

For manual updates: download the new `lolproxchat.exe` from [Releases](https://github.com/danthi123/LoLProxChat/releases/latest) and replace your existing copy.

### Verifying downloads

Every release body includes a SHA-256 hash of the exe. Compare against your download:

```bash
# Windows PowerShell
Get-FileHash lolproxchat.exe

# WSL / git-bash
sha256sum lolproxchat.exe

# Linux/macOS
shasum -a 256 lolproxchat.exe
```

The hash defends against in-transit tampering, mirror reposts, and typosquatted re-uploads. It does *not* defend against you having downloaded from the wrong URL — always start from <https://github.com/danthi123/LoLProxChat/releases>.

## Uninstalling

LoLProxChat is a portable executable with no installer. Removing it is two steps:

1. **Delete the exe** wherever you put it (probably Downloads or a folder you chose).
2. **Delete app data:** open `Run` (Win+R), paste `%LOCALAPPDATA%\com.proxchat.app\`, then delete the folder. It contains:
   - WebView2 cache (cookies, localStorage, IndexedDB)
   - Your Settings (auto-update toggle, device picks, etc.)
   - `lolproxchat.log` + `lolproxchat.1.log` + `lolproxchat.2.log` if you ever turned Debug on

That's the full footprint. No registry entries, nothing under "Programs and Features", no startup tasks, no services.
