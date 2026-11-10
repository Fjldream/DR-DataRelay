@echo off
setlocal EnableExtensions DisableDelayedExpansion
set "BASE_DIR=%~dp0"
if not exist "%BASE_DIR%runtime\node.exe" (
  echo [ERROR] Copy this CMD file into the running Data Relay folder next to start.cmd.
  pause
  exit /b 1
)
if not exist "%BASE_DIR%data\data-relay.db" (
  echo [ERROR] data\data-relay.db was not found. Check the running program folder.
  pause
  exit /b 1
)
pushd "%BASE_DIR%"
echo Read-only KH task query. No service restart required.
echo Device: 20190320077  Tags: test111, test112
echo.
"%BASE_DIR%runtime\node.exe" --input-type=commonjs -e "let db;try{const Database=require('better-sqlite3');db=new Database('./data/data-relay.db',{readonly:true,fileMustExist:true});db.pragma('busy_timeout=5000');const rows=db.prepare('SELECT d.stc,t.tag_name,t.data_value,t.write_time,t.status,t.attempts,t.last_error FROM delivery_tasks t JOIN devices d ON d.id=t.device_id WHERE d.stc=? AND t.tag_name IN (?,?) ORDER BY t.id DESC LIMIT 50').all('20190320077','test111','test112');console.table(rows);if(!rows.length)console.log('No matching tasks found. Check device STC, saved mapping, and packet reception.');console.log('succeeded = accepted according to KH API response; confirm by reading KH history.');console.log('pending/sending = waiting/in progress; retry/deferred = failed, see last_error; license_hold = held by license.');}catch(error){console.error('[ERROR] '+error.message);process.exitCode=1;}finally{if(db)db.close();}"
set "QUERY_RESULT=%ERRORLEVEL%"
popd
echo.
pause
exit /b %QUERY_RESULT%
