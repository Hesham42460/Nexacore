@echo off
cd /d "%~dp0"
set "PATH=%PATH%;C:\Program Files\nodejs"
where node >nul 2>nul || (echo Node.js 22.5+ is required: https://nodejs.org & pause & exit /b 1)
start "" http://localhost:3000
node --no-warnings server.js
pause
