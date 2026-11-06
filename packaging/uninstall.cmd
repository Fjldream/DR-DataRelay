@echo off
setlocal
set "BASE_DIR=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%BASE_DIR%windows-service.ps1" -Action uninstall -IfInstalled
if not errorlevel 3 exit /b %ERRORLEVEL%
set "PM2_HOME=%BASE_DIR%data\pm2"
set "NODE=%BASE_DIR%runtime\node.exe"
set "PM2=%BASE_DIR%node_modules\pm2\bin\pm2"
"%NODE%" "%PM2%" delete data-relay
"%NODE%" "%PM2%" save --force
"%NODE%" "%PM2%" kill
echo Data Relay process removed. data and logs were preserved.
endlocal
