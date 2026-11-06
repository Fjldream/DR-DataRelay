@echo off
setlocal
set "BASE_DIR=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%BASE_DIR%windows-service.ps1" -Action restart -IfInstalled
if not errorlevel 3 exit /b %ERRORLEVEL%
set "PM2_HOME=%BASE_DIR%data\pm2"
set "DATA_RELAY_NODE=%BASE_DIR%runtime\node.exe"
"%DATA_RELAY_NODE%" "%BASE_DIR%node_modules\pm2\bin\pm2" restart data-relay --update-env
endlocal
