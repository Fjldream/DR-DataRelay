@echo off
setlocal EnableExtensions
cd /d "%~dp0.."

set "TOOL_NODE=node.exe"
if exist "%~dp0runtime\node.exe" set "TOOL_NODE=%~dp0runtime\node.exe"
if not exist "%~dp0license-authority" mkdir "%~dp0license-authority"
set "LICENSE_TOOL_HOME=%~dp0license-authority"

echo Starting Data Relay License Tool...
echo Close this window to stop the tool.
echo.
"%TOOL_NODE%" "%~dp0license-tool-server.mjs"

echo.
echo License Tool stopped or failed. Review the message above.
pause
