@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo Starting Data Relay Windows dual-package builder...
echo A complete log will be written to build-windows.log.
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\build-windows.ps1"
set "BUILD_EXIT=%ERRORLEVEL%"

echo.
if "%BUILD_EXIT%"=="0" (
  echo Both source and JSC packages were built successfully.
) else (
  echo Build failed with exit code %BUILD_EXIT%.
  echo Open this file for the complete error:
  echo %~dp0build-windows.log
)
echo.
pause
exit /b %BUILD_EXIT%
