@echo off
setlocal
set "BASE_DIR=%~dp0"
set "PM2_HOME=%BASE_DIR%data\pm2"
"%BASE_DIR%runtime\node.exe" "%BASE_DIR%node_modules\pm2\bin\pm2" logs data-relay --lines 200
endlocal
