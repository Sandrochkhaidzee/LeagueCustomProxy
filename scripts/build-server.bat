@echo off
REM Release build for signaling host — output: release\server.exe
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
echo Building RELEASE server host app ...
if "%GITHUB_REPOSITORY%"=="" set "GITHUB_REPOSITORY=Sandrochkhaidzee/LeagueCustomProxy"
call "%~dp0generate-icons.bat"
if %ERRORLEVEL% neq 0 exit /b %ERRORLEVEL%
call npm run build:server
if %ERRORLEVEL% neq 0 exit /b %ERRORLEVEL%
call npm run build --prefix server
if %ERRORLEVEL% neq 0 exit /b %ERRORLEVEL%
call npx tauri build --no-bundle --config src-tauri/tauri.server.conf.json -- --bin leagueproxy-server
if %ERRORLEVEL% neq 0 exit /b %ERRORLEVEL%
if not exist "%~dp0..\release" mkdir "%~dp0..\release"
for %%F in ("%~dp0..\src-tauri\target\release\leagueproxy-server.exe") do (
  copy /Y "%%F" "%~dp0..\release\server.exe" >nul
  echo.
  echo Build complete: release\server.exe
  powershell -NoProfile -Command "Get-FileHash '%~dp0..\release\server.exe' -Algorithm SHA256 | Format-List"
  goto :done
)
echo ERROR: no leagueproxy-server.exe in src-tauri\target\release
exit /b 1
:done
