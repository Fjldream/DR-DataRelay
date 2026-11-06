@echo off
setlocal EnableExtensions
cd /d "%~dp0.."

set "TOOL_NODE=node.exe"
if exist "%~dp0runtime\node.exe" set "TOOL_NODE=%~dp0runtime\node.exe"
set "KEY_DIR=%~dp0license-authority\keys"

echo ==================================================
echo Data Relay signing key initialization
echo ==================================================
echo.
echo This operation is required only once.
echo The private key and passphrase must never be sent to a customer.
echo.
set /p "KEY_ID=Key ID [prod-2026-01]: "
if "%KEY_ID%"=="" set "KEY_ID=prod-2026-01"

"%TOOL_NODE%" "%~dp0license-generator.mjs" keygen --output "%KEY_DIR%" --key-id "%KEY_ID%" --create-passphrase-file true
if errorlevel 1 goto failed

echo.
echo Signing key initialized in:
echo %KEY_DIR%
echo Move PRIVATE_KEY_PASSPHRASE.txt to a separate secure location after recording it.
echo Copy license-public-keys.json into the product config before building customer packages.
echo.
pause
exit /b 0

:failed
echo.
echo Key initialization failed. Review the error above.
pause
exit /b 1
