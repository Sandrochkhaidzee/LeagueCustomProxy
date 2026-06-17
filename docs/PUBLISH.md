# Publish to GitHub

Repo: **https://github.com/Sandrochkhaidzee/LeagueCustomProxy**

## Automated release (recommended)

1. Commit and push all changes on `main`.
2. Tag the version:

```powershell
cd c:\Users\PC\OneDrive\Desktop\LeagueProxy
git tag v2.0.0
git push origin v2.0.0
```

3. GitHub Actions (`.github/workflows/release.yml`) builds `leagueproxy.exe` and `server.exe`, then creates the release with SHA-256 hashes in the notes.

Tags containing `beta`, `alpha`, or `rc` are marked **pre-release**. Stable tags like `v2.0.0` are full releases.

## Manual release

1. Run `scripts\build-client.bat` and `scripts\build-server.bat`
2. GitHub → Releases → Draft → tag `v2.0.0` → upload `release\leagueproxy.exe` and `release\server.exe`
3. Paste the SHA-256 hashes from the build output into the release notes

## Before you ship

- [ ] Host runs `server.exe` (or `scripts\start-server.bat` for dev) during games
- [ ] Host shares protocol, IP, and port — friends enter them on launch
- [ ] All 10 players use **Borderless** League window mode
- [ ] Release notes include SHA-256 hashes for both exes

## Friends

1. [Releases](https://github.com/Sandrochkhaidzee/LeagueCustomProxy/releases) → download `leagueproxy.exe` (players) and `server.exe` (host)
2. Enter the host's protocol, IP, and port on the connect screen
3. Run exe → League Borderless → custom game

**Host:** `server.exe` before each session (or `scripts\start-server.bat` for developers).
