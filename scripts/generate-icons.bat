@echo off
cd /d "%~dp0.."
call npm run generate:icons
if %ERRORLEVEL% neq 0 exit /b %ERRORLEVEL%
echo Icons ready.
