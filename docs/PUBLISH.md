# Publish to GitHub

Repo: **https://github.com/Sandrochkhaidzee/LeagueCustomProxy**

## Automated release (recommended)

1. Commit and push all changes on `main`.
2. Tag the version:

```powershell
cd c:\Users\PC\OneDrive\Desktop\LeagueProxy
git tag v1.0.0
git push origin v1.0.0
```

3. GitHub Actions (`.github/workflows/release.yml`) builds `leagueproxy.exe` and creates the release with SHA-256 in the notes.

Tags containing `beta`, `alpha`, or `rc` are marked **pre-release**. Stable tags like `v1.0.0` are full releases.

## Manual release

1. Run `scripts\build-client.bat`
2. GitHub → Releases → Draft → tag `v1.0.0` → upload `release\leagueproxy.exe`
3. Paste the SHA-256 from the build output into the release notes

## Before you ship

- [ ] Host runs `scripts\start-server.bat` during games
- [ ] `.env` has the correct `PROXCHAT_SERVER` for your Radmin IP (used at build time)
- [ ] All 10 players use **Borderless** League window mode
- [ ] Release notes include SHA-256 hash

## Friends

1. [Releases](https://github.com/Sandrochkhaidzee/LeagueCustomProxy/releases) → download `leagueproxy.exe`
2. Join Radmin VPN
3. Run exe → League Borderless → custom game

**Host:** `scripts\start-server.bat` before each session.
