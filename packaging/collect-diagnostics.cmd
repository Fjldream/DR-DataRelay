@echo off
setlocal EnableExtensions
set "BASE_DIR=%~dp0"
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"') do set "STAMP=%%i"
set "WORK_DIR=%BASE_DIR%diagnostics\data-relay-%STAMP%"
set "ZIP_FILE=%BASE_DIR%diagnostics\data-relay-%STAMP%.zip"

if not exist "%BASE_DIR%diagnostics" mkdir "%BASE_DIR%diagnostics"
mkdir "%WORK_DIR%"

if exist "%BASE_DIR%logs" xcopy "%BASE_DIR%logs\*" "%WORK_DIR%\logs\" /E /I /Y >nul
if exist "%BASE_DIR%VERSION.json" copy /Y "%BASE_DIR%VERSION.json" "%WORK_DIR%\VERSION.json" >nul
if exist "%BASE_DIR%SHA256SUMS.txt" copy /Y "%BASE_DIR%SHA256SUMS.txt" "%WORK_DIR%\SHA256SUMS.txt" >nul

set "REPORT_SCRIPT=%BASE_DIR%tools\diagnostics-report.js"
if not exist "%REPORT_SCRIPT%" set "REPORT_SCRIPT=%BASE_DIR%tools\diagnostics-report.cjs"
if exist "%REPORT_SCRIPT%" "%BASE_DIR%runtime\node.exe" "%REPORT_SCRIPT%" "%BASE_DIR%" "%WORK_DIR%\sanitized-state.json"

(
  echo Data Relay diagnostics
  echo Collected: %DATE% %TIME%
  echo Computer: %COMPUTERNAME%
  echo Windows: %OS%
  echo.
  echo Node runtime:
  "%BASE_DIR%runtime\node.exe" --version
  echo.
  echo Windows service status:
  powershell -NoProfile -ExecutionPolicy Bypass -File "%BASE_DIR%windows-service.ps1" -Action status
) > "%WORK_DIR%\diagnostics-info.txt" 2>&1

powershell -NoProfile -ExecutionPolicy Bypass -Command "Compress-Archive -Path (Join-Path $env:WORK_DIR '*') -DestinationPath $env:ZIP_FILE -Force"
if errorlevel 1 (
  echo [ERROR] Failed to create diagnostics ZIP.
  echo The copied files remain in: %WORK_DIR%
  pause
  exit /b 1
)

echo Diagnostics package created:
echo %ZIP_FILE%
echo.
echo This package excludes .env, KH password, activation file, private keys, raw frames, and data-relay.db.
echo Send this ZIP to technical support for diagnosis.
pause
