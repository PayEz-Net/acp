@echo off
setlocal enabledelayedexpansion

set "WRAPPER_DIR=%~dp0"
rem Remove trailing backslash
if "%WRAPPER_DIR:~-1%"=="\" set "WRAPPER_DIR=%WRAPPER_DIR:~0,-1%"

rem Find real claude.exe by stripping our dir from PATH
set "SEARCH_PATH=%PATH%"
set "REAL_CLAUDE="

rem Remove ACP_BIN_DIR from path to avoid finding ourselves
set "CLEAN_PATH="
for %%d in ("%SEARCH_PATH:;=" "%") do (
  set "ENTRY=%%~d"
  if /i not "!ENTRY!"=="%WRAPPER_DIR%" (
    if defined CLEAN_PATH (
      set "CLEAN_PATH=!CLEAN_PATH!;!ENTRY!"
    ) else (
      set "CLEAN_PATH=!ENTRY!"
    )
  )
)

rem Search for claude.exe in cleaned PATH
for %%I in (claude.exe) do (
  set "FOUND=%%~$CLEAN_PATH:I"
  if defined FOUND (
    set "REAL_CLAUDE=!FOUND!"
  )
)

if not defined REAL_CLAUDE (
  echo acp-wrapper: claude.exe not found in PATH ^(excluding %WRAPPER_DIR%^) >&2
  exit /b 127
)

rem Pass-through if not inside ACP surface
if not defined ACP_SURFACE_ID goto :passthrough
if "%ACP_HOOKS_DISABLED%"=="1" goto :passthrough

rem Pass-through for non-session subcommands
set "FIRST_ARG=%~1"
if "%FIRST_ARG%"=="mcp" goto :passthrough
if "%FIRST_ARG%"=="config" goto :passthrough
if "%FIRST_ARG%"=="api-key" goto :passthrough
if "%FIRST_ARG%"=="auth" goto :passthrough
if "%FIRST_ARG%"=="doctor" goto :passthrough
if "%FIRST_ARG%"=="--version" goto :passthrough
if "%FIRST_ARG%"=="--help" goto :passthrough

rem Unset CLAUDECODE to prevent nested session detection
set "CLAUDECODE="

rem Build hooks JSON
set "HOOKS_JSON={\"hooks\":{\"SessionStart\":[{\"matcher\":\"\",\"hooks\":[{\"type\":\"command\",\"command\":\"acp-hook session-start\",\"timeout\":10}]}],\"Stop\":[{\"matcher\":\"\",\"hooks\":[{\"type\":\"command\",\"command\":\"acp-hook stop\",\"timeout\":10}]}],\"Notification\":[{\"matcher\":\"\",\"hooks\":[{\"type\":\"command\",\"command\":\"acp-hook notification\",\"timeout\":10}]}]}}"

rem The ACP spawn command (buildClaudeSpawnCommand) is the AUTHORITY on session
rem identity: it passes --session-id <id> to CREATE, or --resume <id> to RESUME.
rem If we ALSO inject --session-id, a resume reaches the real CLI as
rem "--session-id X --resume Y", which claude >= 2.1.220 rejects with
rem "--session-id can only be used with --continue or --resume if --fork-session
rem is also specified" — killing every resume spawn (and doubling --session-id on
rem create). So only inject our own session id when the caller passed NO session
rem flag (a bare/manual `claude` in a pane). SHIFT does not affect %*, so the
rem passthrough below still forwards the original argument list.
set "HAS_SESSION_FLAG="
:scan_session_flag
if "%~1"=="" goto :scan_session_done
if /i "%~1"=="--session-id" set "HAS_SESSION_FLAG=1"
if /i "%~1"=="--resume" set "HAS_SESSION_FLAG=1"
if /i "%~1"=="-r" set "HAS_SESSION_FLAG=1"
if /i "%~1"=="--continue" set "HAS_SESSION_FLAG=1"
if /i "%~1"=="-c" set "HAS_SESSION_FLAG=1"
shift
goto :scan_session_flag
:scan_session_done

if defined HAS_SESSION_FLAG goto :caller_owns_session

rem No caller session flag — generate one so lifecycle hooks still attach.
for /f %%G in ('powershell -NoProfile -Command "[guid]::NewGuid().ToString()"') do set "SESSION_ID=%%G"
"%REAL_CLAUDE%" --session-id "%SESSION_ID%" --settings "%HOOKS_JSON%" %*
exit /b %ERRORLEVEL%

:caller_owns_session
rem Caller supplied --session-id/--resume/--continue; only attach hooks.
"%REAL_CLAUDE%" --settings "%HOOKS_JSON%" %*
exit /b %ERRORLEVEL%

:passthrough
"%REAL_CLAUDE%" %*
exit /b %ERRORLEVEL%
