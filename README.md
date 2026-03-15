# Upbit 스캘핑 · 자산 대시보드

Node.js(Express) + Socket.IO 기반 업비트 스캘핑 엔진, 웹 대시보드, Discord 봇(매매 제어 + MarketSearchEngine 시황 분석).

---

## 미니PC 설치 가이드 (도착 후 실행 순서)

### 1. 저장소 클론

```bash
git clone https://github.com/YOUR_USERNAME/upbit-price-alert.git
cd upbit-price-alert/dashboard
```

### 2. 의존성 설치

```bash
npm install
```

### 3. 환경 변수 설정

- `.env.example`을 복사해 `.env` 파일을 만든 뒤, 실제 키 값을 채웁니다.

  **Windows (CMD):**
  ```cmd
  copy .env.example .env
  ```

  **Windows (PowerShell) / Mac / Linux:**
  ```bash
  cp .env.example .env
  ```

- `.env`에서 필수로 채울 항목:
  - `UPBIT_ACCESS_KEY`, `UPBIT_SECRET_KEY` (업비트 Open API)
  - `DISCORD_TOKEN`, `CHANNEL_ID` (매매 봇)
  - `ADMIN_ID` (디스코드 사용자 ID, 버튼 제어용)
  - 시황 봇 사용 시: `MARKET_BOT_TOKEN`
  - Gemini 사용 시: `GEMINI_API_KEY`

### 4. PM2로 실행

**대시보드(매매 봇 포함) 한 번에 실행:**

```bash
npx pm2 start server.js --name "scalp-dashboard"
```

**시황 분석 봇(MarketSearchEngine) 별도 실행:**

```bash
npx pm2 start market_search.js --name "MarketSearchEngine"
```

**자동 재시작 설정 (선택):**

```bash
npx pm2 save
npx pm2 startup
```

### 5. 확인

- 브라우저: `http://localhost:3000` (또는 미니PC IP:3000)
- 디스코드: 해당 채널에 제어 패널·시황 버튼 메시지 수신 여부 확인

---

## 주요 스크립트 (package.json)

| 스크립트 | 설명 |
|---------|------|
| `npm start` | `node server.js` (대시보드 + 매매 봇) |
| `npm run pm2:start` | ecosystem 설정으로 PM2 시작 |
| `npm run pm2:logs` | PM2 로그 보기 |

---

## 보안

- **`.env`는 절대 Git에 올리지 마세요.** 이미 추적 중이라면:
  ```bash
  git rm --cached .env
  ```
  실행 후 커밋하여 추적만 제거하고, 로컬 `.env` 파일은 유지됩니다.
- API 키·토큰은 `.env` 또는 `config.json`(역시 .gitignore 권장)에만 두고, 코드에는 하드코딩하지 마세요.

---

## 의존성 요약

- **discord.js** — Discord 봇
- **express**, **socket.io** — 웹 서버·실시간 push
- **axios** — Upbit/Gemini 등 HTTP
- **dotenv** — 환경 변수 로드
- **@google/generative-ai** — Gemini 시황 분석
- **sqlite3** — 거래 기록 DB

`node-cron`은 사용하지 않으며, 스케줄은 `setInterval` 등으로 처리됩니다.
