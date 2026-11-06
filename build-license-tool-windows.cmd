@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo Starting Data Relay License Tool Windows builder...
echo A complete log will be written to build-license-tool-windows.log.
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\build-license-tool-windows.ps1"
set "BUILD_EXIT=%ERRORLEVEL%"

echo.
if "%BUILD_EXIT%"=="0" (
  echo License Tool build completed successfully.
) else (
  echo License Tool build failed with exit code %BUILD_EXIT%.
  echo Open: %~dp0build-license-tool-windows.log
)
echo.
pause
exit /b %BUILD_EXIT%
