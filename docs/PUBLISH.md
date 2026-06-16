# Publish to GitHub

Repo: **https://github.com/Sandrochkhaidzee/LeagueCustomProxy**

## Push code

```powershell
cd c:\Users\PC\OneDrive\Desktop\LeagueProxy
git remote set-url origin https://github.com/Sandrochkhaidzee/LeagueCustomProxy.git
git push -u origin main
```

## Create beta release (automated)

```powershell
git tag v0.1.0-beta.1
git push origin v0.1.0-beta.1
```

GitHub Actions builds `leagueproxy.exe` and attaches it to the release (pre-release).

## Manual release

1. Run `scripts\build-client.bat`
2. GitHub → Releases → Draft → tag `v0.1.0-beta.1` → upload `release\leagueproxy.exe`

## Friends

1. [Releases](https://github.com/Sandrochkhaidzee/LeagueCustomProxy/releases) → download `leagueproxy.exe`
2. Join Radmin VPN
3. Run exe → League Borderless → custom game

**Host:** `scripts\start-server.bat` before each session.
