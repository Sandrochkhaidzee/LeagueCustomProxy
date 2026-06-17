@echo off
REM Dev build — includes Debug / Debug Logs UI (PROXCHAT_DEV_BUILD=1)
set "VCVARS=C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
if not exist "%VCVARS%" (
  echo ERROR: Visual Studio Build Tools not found at %VCVARS%
  exit /b 1
)
call "%VCVARS%"
set "PATH=C:\Program Files\nodejs;%USERPROFILE%\.cargo\bin;%PATH%"
cd /d "%~dp0.."
if not exist .env copy .env.example .env
set PROXCHAT_DEV_BUILD=1
echo Building DEV client (debug UI enabled) ...
if "%GITHUB_REPOSITORY%"=="" set "GITHUB_REPOSITORY=Sandrochkhaidzee/LeagueCustomProxy"
call npm run build:dev
if %ERRORLEVEL% neq 0 exit /b %ERRORLEVEL%
call npx tauri build --no-bundle -- --profile release-fast
if %ERRORLEVEL% neq 0 exit /b %ERRORLEVEL%
if not exist "%~dp0..\release" mkdir "%~dp0..\release"
for %%F in ("%~dp0..\src-tauri\target\release-fast\*.exe") do (
  copy /Y "%%F" "%~dp0..\release\leagueproxy-dev.exe" >nul
  echo.
  echo Dev build complete: release\leagueproxy-dev.exe
  goto :done
)
echo ERROR: no exe in src-tauri\target\release-fast
exit /b 1
:done
