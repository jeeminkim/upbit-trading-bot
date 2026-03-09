@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo [1/2] 패키지 설치 중...
call npm install
if errorlevel 1 (
  echo npm을 찾을 수 없습니다. Node.js를 설치한 뒤 다시 시도하세요.
  pause
  exit /b 1
)

echo [2/2] 서버 시작 중... (종료하려면 이 창을 닫으세요)
echo 브라우저에서 http://localhost:3000 을 열어주세요.
echo.
call npm start
pause
