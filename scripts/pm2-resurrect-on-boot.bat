@echo off
REM Windows 부팅/로그인 시 PM2 앱 복구 (작업 스케줄러에서 이 파일을 실행하도록 설정)
REM 사용 전: pm2 start ecosystem.config.cjs 후 pm2 save 한 번 실행해 두세요.

cd /d "%~dp0.."
call pm2 resurrect 2>nul
if errorlevel 1 (
  REM 저장된 목록이 없으면 ecosystem으로 시작
  call pm2 start ecosystem.config.cjs
)
exit /b 0
