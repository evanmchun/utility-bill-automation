@echo off
setlocal

cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "npm run drafts"

echo.
echo Press any key to close this window.
pause >nul
