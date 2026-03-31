@echo off
setlocal enabledelayedexpansion

set "WRAPPER_DIR=%~dp0"
if "%WRAPPER_DIR:~-1%"=="\" set "WRAPPER_DIR=%WRAPPER_DIR:~0,-1%"

rem Find real openclaw.exe by stripping our dir from PATH
set "SEARCH_PATH=%PATH%"
set "REAL_OPENCLAW="

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

for %%I in (openclaw.exe) do (
  set "FOUND=%%~$CLEAN_PATH:I"
  if defined FOUND (
    set "REAL_OPENCLAW=!FOUND!"
  )
)

if not defined REAL_OPENCLAW (
  echo acp-wrapper: openclaw.exe not found in PATH ^(excluding %WRAPPER_DIR%^) >&2
  exit /b 127
)

rem Pass-through if not inside ACP surface
if not defined ACP_SURFACE_ID goto :passthrough
if "%ACP_HOOKS_DISABLED%"=="1" goto :passthrough

rem Pass-through for non-session subcommands
set "FIRST_ARG=%~1"
if "%FIRST_ARG%"=="--version" goto :passthrough
if "%FIRST_ARG%"=="--help" goto :passthrough

set "CLAUDECODE="

set "HOOKS_JSON={\"hooks\":{\"SessionStart\":[{\"matcher\":\"\",\"hooks\":[{\"type\":\"command\",\"command\":\"acp-hook session-start\",\"timeout\":10}]}],\"Stop\":[{\"matcher\":\"\",\"hooks\":[{\"type\":\"command\",\"command\":\"acp-hook stop\",\"timeout\":10}]}],\"Notification\":[{\"matcher\":\"\",\"hooks\":[{\"type\":\"command\",\"command\":\"acp-hook notification\",\"timeout\":10}]}]}}"

for /f %%G in ('powershell -NoProfile -Command "[guid]::NewGuid().ToString()"') do set "SESSION_ID=%%G"

"%REAL_OPENCLAW%" --session-id "%SESSION_ID%" --settings "%HOOKS_JSON%" %*
exit /b %ERRORLEVEL%

:passthrough
"%REAL_OPENCLAW%" %*
exit /b %ERRORLEVEL%
