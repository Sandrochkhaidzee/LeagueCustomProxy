@echo off
echo.
echo NOTE: Use server.exe (LeagueProxy Host) to start the signaling server.
echo       This script is for developers only.
echo.
cd /d "%~dp0..\server"
if not exist node_modules (
  echo Installing server dependencies...
  call npm install
)
if not exist dist\index.js (
  echo Building server...
  call npm run build
)
echo Starting signaling server on port 3100 (no admin panel — use server.exe instead)
set PORT=3100
call npm start
