# 구동 및 로그 모니터링 방법

## 1. 사전 준비

- **Node.js** 설치 (권장 v18+)
- **.env** 설정: `dashboard/.env`에 업비트 API 키, Discord 토큰, GEMINI_API_KEY 등 필요 값 설정
- 터미널 작업 디렉터리: **`dashboard`** (프로젝트 루트가 아닌 dashboard 폴더)

```powershell
cd "c:\Users\kingj\OneDrive\문서\upbit-price-alert\dashboard"
```

---

## 2. 구동 방법

### 방법 A: 직접 실행 (개발/테스트용)

```bash
npm start
```

- `node server.js` 실행. 콘솔에 로그가 바로 출력됨.
- 종료: `Ctrl+C`

### 방법 B: PM2로 실행 (운영 권장)

**2개 앱 (대시보드+매매 엔진 + 마켓 검색)**

```bash
npm run start:all
# 또는
npm run pm2:start
```

- **upbit-bot**: `server.js` (대시보드 + 매매 엔진 + Discord 봇)
- **MarketSearchEngine**: `market_search.js`

**재시작**

```bash
npm run restart:all
# 또는
npx pm2 restart ecosystem.config.cjs
```

**중지**

```bash
npm run stop:all
```

**엔진만 켠 설정으로 시작** (upbit-bot만 Signal/Risk/Execution/Position 엔진 ON)

```bash
npm run pm2:start:engine
```

---

## 3. 로그 모니터링

### PM2 실시간 로그 (추천)

```bash
npm run pm2:logs
# 또는
npx pm2 logs --lines 300
```

- **upbit-bot** / **MarketSearchEngine** 둘 다 stdout+stderr 실시간 출력.
- `--lines 300`: 최근 300줄부터 표시.

**특정 앱만**

```bash
npx pm2 logs upbit-bot --lines 200
```

**에러 로그만**

```bash
npm run pm2:logs:err
# 또는
npx pm2 logs upbit-bot --err --lines 300
```

### PM2 상태 확인

```bash
npm run pm2:status
```

- `api-server`, `upbit-bot`, `MarketSearchEngine`, `discord-operator`, `market-bot` 온라인/오프라인 표.

### 로그 파일 직접 보기

PM2가 쓰는 로그 파일 위치: **`dashboard/logs/`**

| 파일 | 내용 |
|------|------|
| `pm2-upbit-bot-out.log` | upbit-bot 표준 출력 (console.log 등) |
| `pm2-upbit-bot-error.log` | upbit-bot 표준 에러 |
| `pm2-MarketSearchEngine-out.log` | MarketSearchEngine 표준 출력 |
| `trade.log` | 매매/체결 관련 로그 (로테이션됨) |
| `independent_scalp.log` | 독립 스캘프 봇 로그 |
| `gemini-error-diagnostic.log` | Gemini API 오류 시 진단 로그 |
| `meme_engine.log` | 밈 엔진 로그 |

**예: PowerShell에서 최근 로그 보기**

```powershell
Get-Content "c:\Users\kingj\OneDrive\문서\upbit-price-alert\dashboard\logs\pm2-upbit-bot-out.log" -Tail 100 -Wait
```

**예: Gemini 오류만 보기**

```bash
npm run pm2:logs:gemini
# 또는
node scripts/show-gemini-diagnostic-log.js
```

---

## 4. 요약 치트시트

| 목적 | 명령 |
|------|------|
| **한 번에 실행** | `cd dashboard` → `npm run start:all` |
| **실시간 로그** | `npm run pm2:logs` |
| **상태 확인** | `npm run pm2:status` |
| **재시작** | `npm run restart:all` |
| **중지** | `npm run stop:all` |
| **직접 실행(콘솔 로그)** | `npm start` |

로그는 **PM2 사용 시** `logs/` 아래 파일 + `pm2 logs`로 모니터링하면 됩니다.
