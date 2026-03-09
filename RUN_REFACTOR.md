# 리팩터 구조 서비스 실행 방법

빌드 후 아래 순서로 실행하면 됩니다. **반드시 프로젝트 루트(dashboard 폴더)에서** 실행하세요.

**주의:** `npm start`는 기존 **server.js**(레거시)를 띄웁니다. 리팩터 서비스는 `pm2:refactor` / `pm2:refactor:restart` 만 사용하세요.

**upbit-bot 메인 사용 시 (api-server 띄우지 않을 때):**  
PM2 5개(upbit-bot, MarketSearchEngine, api-server, discord-operator, market-bot) 중 역할이 중복되는 api-server는 제외하고 **4개**만 사용합니다.  
- **시작:** `npm run pm2:main` (빌드 후 upbit-bot, MarketSearchEngine, discord-operator, market-bot 4개 시작)  
- **재기동:** `npm run pm2:main:restart` (위 4개만 한 번에 재기동, api-server는 건드리지 않음)  
- **중지:** `npm run pm2:main:stop`  
설정 파일: `ecosystem.main.config.cjs`

## 1. 한 번만: 빌드

```bash
npm run build:refactor
```

## 2. 서비스 띄우기 (두 가지 중 하나)

### 방법 A: PM2로 3개 프로세스 한 번에 실행 (권장)

```bash
npm run pm2:refactor
```

- **api-server**: Express + Socket.IO + trading-engine 루프 (포트 기본 3000)
- **discord-operator**: 디스코드 슬래시 명령 (/engine, /status, /pnl 등)
- **market-bot**: 분석 버튼용 봇

PM2 명령어:

- **재시작(빌드 후)**  
  ```bash
  npm run pm2:refactor:restart
  ```
- 로그 보기: `npm run pm2:refactor:logs` 또는 `pm2 logs`
- 중지: `npm run pm2:refactor:stop` 또는 `pm2 delete api-server discord-operator market-bot`
- 상태 확인: `pm2 status`

### 포트 3000 사용 중(EADDRINUSE)일 때

리팩터가 아닌 `node server.js`가 3000을 쓰고 있거나, 이미 api-server가 떠 있을 수 있습니다.

1. PM2로 띄운 경우:  
   `npm run pm2:refactor:stop`  
   또는 레거시: `pm2 delete upbit-bot` 등으로 해당 앱 중지
2. 그냥 node로 띄운 경우:  
   해당 터미널에서 Ctrl+C 하거나, 작업 관리자에서 해당 node 프로세스 종료
3. 그 다음 리팩터만 다시 띄우기:  
   `npm run pm2:refactor` 또는 `npm run pm2:refactor:restart`

### 방법 B: api-server만 실행 (개발/테스트용)

```bash
npm run start:refactor
```

- api-server만 실행되며, 내부에서 trading-engine 루프도 함께 돌아갑니다.
- Discord 봇·market-bot은 띄우지 않습니다.

## 3. 필요한 환경 변수 (.env)

- **api-server**: `PORT`(선택, 기본 3000), Upbit/DB 등은 `server.js`에서 쓰는 기존 설정 사용
- **discord-operator**: `DISCORD_TOKEN` 또는 `DISCORD_BOT_TOKEN`, `CHANNEL_ID`, `DASHBOARD_URL`(예: http://localhost:3000), 관리자 DM용 `ADMIN_ID`
- **market-bot**: `MARKET_BOT_TOKEN`(또는 `MARKET_SEARCH_ENGINE_TOKEN`), `DASHBOARD_URL`

`.env`는 각 앱 진입점에서 `process.cwd()` 기준으로 자동 로드됩니다. PM2는 `ecosystem.refactor.config.cjs`의 `cwd`가 프로젝트 루트이므로 같은 `.env`를 사용합니다.

## 4. 실행 순서 요약

```bash
cd C:\Users\kingj\OneDrive\문서\upbit-price-alert\dashboard
npm install
npm run build:refactor
npm run pm2:refactor
```

이후 브라우저에서 `http://localhost:3000` 접속, Discord에서 슬래시 명령으로 제어하면 됩니다.
