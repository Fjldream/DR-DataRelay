@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows-service.ps1" -Action uninstall
set "RESULT=%ERRORLEVEL%"
pause
exit /b %RESULT%
