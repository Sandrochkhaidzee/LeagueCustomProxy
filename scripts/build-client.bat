@echo off
REM Release build — no Debug / Debug Logs UI. Output: release\leagueproxy.exe
set "VCVARS=C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
if not exist "%VCVARS%" (
  echo ERROR: Visual Studio Build Tools not found at %VCVARS%
  exit /b 1
)
call "%VCVARS%"
set "PATH=C:\Program Files\nodejs;%USERPROFILE%\.cargo\bin;%PATH%"
cd /d "%~dp0.."
if not exist .env copy .env.example .env
set PROXCHAT_DEV_BUILD=0
echo Building RELEASE client (no debug UI) ...
if "%GITHUB_REPOSITORY%"=="" set "GITHUB_REPOSITORY=Sandrochkhaidzee/LeagueCustomProxy"
call "%~dp0generate-icons.bat"
if %ERRORLEVEL% neq 0 exit /b %ERRORLEVEL%
call npm run build:release
if %ERRORLEVEL% neq 0 exit /b %ERRORLEVEL%
call npx tauri build --no-bundle -- --bin leagueproxy
if %ERRORLEVEL% neq 0 exit /b %ERRORLEVEL%
if not exist "%~dp0..\release" mkdir "%~dp0..\release"
copy /Y "%~dp0..\src-tauri\target\release\leagueproxy.exe" "%~dp0..\release\leagueproxy.exe" >nul
echo.
echo Build complete: release\leagueproxy.exe
powershell -NoProfile -Command "Get-FileHash '%~dp0..\release\leagueproxy.exe' -Algorithm SHA256 | Format-List"
