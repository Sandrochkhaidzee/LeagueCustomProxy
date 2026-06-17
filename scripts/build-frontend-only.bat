@echo off
REM Rebuild only webpack dist (skip Rust). Use when you changed TS/HTML/CSS but not src-tauri.
set "PATH=C:\Program Files\nodejs;%PATH%"
cd /d "%~dp0.."
if not exist .env copy .env.example .env
set PROXCHAT_DEV_BUILD=0
call npm run build:release
echo Frontend build complete: dist\
