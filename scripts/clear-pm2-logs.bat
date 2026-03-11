@echo off
REM PM2 refactor 앱 로그 비우기. 반드시 먼저: npx pm2 delete api-server discord-operator market-bot
REM 사용: scripts\clear-pm2-logs.bat
cd /d "%~dp0..\logs"

echo [clear-pm2-logs] Clearing refactor app logs...
type nul > "pm2-%%name%%-error-0.log" 2>nul
type nul > "pm2-%%name%%-out-0.log" 2>nul
type nul > "pm2-%%name%%-error-1.log" 2>nul
type nul > "pm2-%%name%%-out-1.log" 2>nul
type nul > "pm2-%%name%%-error-2.log" 2>nul
type nul > "pm2-%%name%%-out-2.log" 2>nul
echo [clear-pm2-logs] done. Run: npx pm2 start ecosystem.refactor.config.cjs
