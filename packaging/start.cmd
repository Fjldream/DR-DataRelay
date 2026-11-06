@echo off
setlocal
set "BASE_DIR=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%BASE_DIR%windows-service.ps1" -Action start -IfInstalled
if not errorlevel 3 exit /b %ERRORLEVEL%
set "PM2_HOME=%BASE_DIR%data\pm2"
set "DATA_RELAY_NODE=%BASE_DIR%runtime\node.exe"
if not exist "%PM2_HOME%" mkdir "%PM2_HOME%"
if not exist "%BASE_DIR%logs" mkdir "%BASE_DIR%logs"
"%DATA_RELAY_NODE%" "%BASE_DIR%node_modules\pm2\bin\pm2" start "%BASE_DIR%ecosystem.config.cjs" --update-env
"%DATA_RELAY_NODE%" "%BASE_DIR%node_modules\pm2\bin\pm2" save
endlocal
