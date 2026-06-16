@echo off
cd /d "%~dp0..\server"
if not exist node_modules (
  echo Installing server dependencies...
  call npm install
)
if not exist dist\index.js (
  echo Building server...
  call npm run build
)
echo Starting signaling server on port 3100 (Radmin: 26.36.227.156)
set PORT=3100
call npm start
