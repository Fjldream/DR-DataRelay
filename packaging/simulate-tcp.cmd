@echo off
setlocal
set "BASE_DIR=%~dp0"
set "SCRIPT=%BASE_DIR%tools\tcp-batch-simulator.js"
if not exist "%SCRIPT%" set "SCRIPT=%BASE_DIR%tools\tcp-batch-simulator.cjs"
if not exist "%SCRIPT%" (
  echo [ERROR] Batch simulator was not found.
  pause
  exit /b 1
)
echo TCP batch simulator
echo Usage: simulate-tcp.cmd [IP] [port] [devices] [interval_ms] [duration_seconds] [samples] [sample_interval_minutes] [print_frames]
echo Defaults: 127.0.0.1 9000 3 5000 60 8 30 true
"%BASE_DIR%runtime\node.exe" "%SCRIPT%" %* --transport tcp
set "EXIT_CODE=%ERRORLEVEL%"
echo.
echo TCP simulator exited with code %EXIT_CODE%.
pause
exit /b %EXIT_CODE%
