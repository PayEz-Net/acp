@echo off
cd /d E:\Repos\acp-desktop
taskkill /PID 19288 /T /F
taskkill /PID 30176 /F 2>NUL
taskkill /PID 32512 /F 2>NUL
timeout /t 2 /nobreak >NUL
call npm run kill-port >> .tmp\dev93.log 2>&1
call npm run dev:93 >> .tmp\dev93.log 2>&1
