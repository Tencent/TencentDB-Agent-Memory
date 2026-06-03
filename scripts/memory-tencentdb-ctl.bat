@echo off
REM Thin .bat wrapper around memory-tencentdb-ctl.ps1 so users can launch
REM the Gateway from cmd.exe or by double-clicking. All real logic lives
REM in the PowerShell script next to this one.
REM
REM Examples:
REM     memory-tencentdb-ctl.bat start
REM     memory-tencentdb-ctl.bat status
REM     memory-tencentdb-ctl.bat stop
REM
REM See scripts\memory-tencentdb-ctl.ps1 for the supported subcommands and
REM the MEMORY_TENCENTDB_* env-var list.

setlocal
set "SCRIPT_DIR=%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%memory-tencentdb-ctl.ps1" %*
exit /b %ERRORLEVEL%
