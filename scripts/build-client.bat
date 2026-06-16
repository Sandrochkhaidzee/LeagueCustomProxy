@echo off
REM Build LeagueProxy — output: release\leagueproxy.exe
set "VCVARS=C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
if not exist "%VCVARS%" (
  echo ERROR: Visual Studio Build Tools not found at %VCVARS%
  exit /b 1
)
call "%VCVARS%"
set "PATH=C:\Program Files\nodejs;%USERPROFILE%\.cargo\bin;%PATH%"
cd /d "%~dp0.."
if not exist .env copy .env.example .env
echo Building with PROXCHAT_SERVER from .env ...
if "%GITHUB_REPOSITORY%"=="" set "GITHUB_REPOSITORY=Sandrochkhaidzee/LeagueCustomProxy"
call npx tauri build
if %ERRORLEVEL% neq 0 exit /b %ERRORLEVEL%
if not exist "%~dp0..\release" mkdir "%~dp0..\release"
for %%F in ("%~dp0..\src-tauri\target\release\*.exe") do (
  copy /Y "%%F" "%~dp0..\release\leagueproxy.exe" >nul
  echo.
  echo Build complete: release\leagueproxy.exe
  powershell -NoProfile -Command "Get-FileHash '%~dp0..\release\leagueproxy.exe' -Algorithm SHA256 | Format-List"
  goto :done
)
echo ERROR: no exe in src-tauri\target\release
exit /b 1
:done