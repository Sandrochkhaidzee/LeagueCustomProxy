@echo off
REM Rebuild only the Rust/Tauri exe (skip webpack). Use after frontend-only changes are already built.
set "VCVARS=C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
if not exist "%VCVARS%" (
  echo ERROR: Visual Studio Build Tools not found at %VCVARS%
  exit /b 1
)
call "%VCVARS%"
set "PATH=C:\Program Files\nodejs;%USERPROFILE%\.cargo\bin;%PATH%"
cd /d "%~dp0.."
call npx tauri build --no-bundle
if %ERRORLEVEL% neq 0 exit /b %ERRORLEVEL%
if not exist "%~dp0..\release" mkdir "%~dp0..\release"
for %%F in ("%~dp0..\src-tauri\target\release\*.exe") do (
  copy /Y "%%F" "%~dp0..\release\leagueproxy.exe" >nul
  echo Rust-only build complete: release\leagueproxy.exe
  goto :done
)
echo ERROR: no exe in src-tauri\target\release
exit /b 1
:done
