# CMD에서 구동 / 정지 / 강제 종료 / 재기동 (통일 가이드)

**리팩터 스택**(api-server + discord-operator + market-bot) 기준. 모든 명령은 **dashboard 폴더**에서 실행.

---

## 1. 사전: 프로젝트 폴더로 이동

```cmd
cd /d "c:\Users\kingj\OneDrive\문서\upbit-price-alert\dashboard"
```

---

## 2. 구동 (시작)

```cmd
npm run pm2:refactor
```

- TypeScript 빌드 후 api-server, discord-operator, market-bot 을 PM2 로 기동.
- **실제 실행 파일**: discord-operator는 `dist-refactor/apps/discord-operator/src/index.js` 를 실행함. `src/` 수정 후 반드시 `npm run build:refactor` 또는 `npm run pm2:refactor` 로 빌드해야 최신 코드가 반영됨.
- 매매 엔진은 **자동으로 시작되지 않음**. Discord `/engine start` 또는 대시보드에서 명시적으로 시작해야 함.

---

## 3. 정지 (정상 종료)

```cmd
npm run pm2:refactor:stop
```

- api-server, discord-operator, market-bot 프로세스를 PM2 에서 삭제(정상 종료).
- 다른 PM2 앱(upbit-bot, MarketSearchEngine 등)이 있으면 그건 그대로 둠.

---

## 4. 문제 발생 시 — 프로세스 바로 kill (강제 종료)

### 4-1. PM2 로 관리 중인 프로세스만 정리

```cmd
npm run pm2:refactor:stop
pm2 kill
```

- `pm2 kill`: PM2 데몬과 PM2 가 띄운 모든 프로세스를 종료.  
  리팩터 3개 앱만 쓸 때는 위 두 줄이면 충분.

### 4-2. 그래도 안 죽을 때 — Node 프로세스 강제 종료 (Windows)

```cmd
taskkill /F /IM node.exe
```

- **주의**: PC에서 돌아가는 **모든** Node 프로세스가 종료됨.  
  다른 Node 앱이 있으면 같이 꺼지므로, 리팩터 앱만 문제일 때는 먼저 4-1 시도.

### 4-3. 특정 포트를 쓰는 프로세스만 kill (선택)

- **api-server**: 기본 포트 3100. `findstr :3100` 으로 확인 후 해당 PID만 종료 가능.
- **market-bot**: 포트 3001. `findstr :3001` 로 확인.

```cmd
for /f "tokens=5" %a in ('netstat -ano ^| findstr :3100') do taskkill /F /PID %a
```

- CMD 한 줄 입력 시 `%a` 그대로, 배치 파일에서는 `%%a`.

---

## 5. 수정 후 재기동 (빌드 + 재시작)

```cmd
npm run pm2:refactor:restart
```

- `build:refactor` 후 ecosystem.refactor.config.cjs 기준으로 3개 앱 **재시작**.
- 코드 수정 후 다시 띄울 때 이 명령 하나로 통일.

---

## 6. 자주 쓰는 명령 요약

| 목적           | 명령어 |
|----------------|--------|
| **구동**       | `npm run pm2:refactor` |
| **정지**       | `npm run pm2:refactor:stop` |
| **재기동**     | `npm run pm2:refactor:restart` |
| **안전 재기동** | `npm run pm2:refactor:safe-restart` (stop → kill → 10초 대기 → 빌드 → start) |
| **문제 시 kill** | `npm run pm2:refactor:stop` → `pm2 kill` (필요 시 `taskkill /F /IM node.exe`) |
| **로그 보기**  | `npm run pm2:refactor:logs` |
| **상태 확인**  | `pm2 status` |

---

## 7. 한 번에 복사해서 쓰기 (CMD)

**구동**
```cmd
cd /d "c:\Users\kingj\OneDrive\문서\upbit-price-alert\dashboard"
npm run pm2:refactor
```

**정지**
```cmd
cd /d "c:\Users\kingj\OneDrive\문서\upbit-price-alert\dashboard"
npm run pm2:refactor:stop
```

**문제 시 강제 종료 후 재기동**
```cmd
cd /d "c:\Users\kingj\OneDrive\문서\upbit-price-alert\dashboard"
npm run pm2:refactor:stop
pm2 kill
npm run pm2:refactor
```

**수정 후 재기동**
```cmd
cd /d "c:\Users\kingj\OneDrive\문서\upbit-price-alert\dashboard"
npm run pm2:refactor:restart
```

---

## 8. 권장 안전 재기동 절차 (포트/재시작 루프 방지)

다음 순서로 하면 포트 충돌·restart storm을 줄일 수 있습니다.

1. **dashboard 폴더로 이동**
   ```cmd
   cd /d "c:\Users\kingj\OneDrive\문서\upbit-price-alert\dashboard"
   ```
2. **정지 후 PM2 데몬 종료**
   ```cmd
   npm run pm2:refactor:stop
   pm2 kill
   ```
3. **(선택) 포트 확인** — api-server 3100 / market-bot 3001 사용 중이면 4-3 참고
   ```cmd
   netstat -ano | findstr :3100
   ```
4. **10초 대기** — 포트 해제 대기
5. **빌드 후 기동**
   ```cmd
   npm run build:refactor
   npm run pm2:refactor
   pm2 list
   ```

**한 번에 실행 (스크립트)**  
```cmd
npm run pm2:refactor:safe-restart
```  
→ stop → pm2 kill → 10초 대기 → 빌드 → start 순으로 실행됩니다.

**taskkill이 필요한 경우**  
- `pm2 kill` 후에도 3100(api-server) 포트가 계속 점유되면, 4-2·4-3 참고.  
- **주의**: `taskkill /F /IM node.exe`는 PC의 모든 Node 프로세스를 종료하므로, 리팩터 앱만 문제일 때는 먼저 4-1·4-3을 시도하세요.

---

## 9. 재기동이 오래 걸릴 때

- **discord-operator**: 재기동 시 기존 패널 복구(또는 `FORCE_NEW_PANEL_ON_RESTART=true` 시 역할 A/B/C 메시지 3개 전송)로 Discord API 호출이 순차 실행됩니다. 보통 0.6~2초, 역할 3개 새로 보낼 때는 수 초~약 20초까지 걸릴 수 있습니다.
- **market-bot**: `server.js` 로드 실패 시 PM2가 재시작을 반복하면서 Stale lock 제거 → require 실패 → 크래시가 반복되면 재기동이 길어질 수 있습니다. `server.js` 문법 오류가 없다면 `node --check server.js` 로 확인 후 재기동하세요.
- **api-server**: 기본 포트 **3100** (환경변수 `PORT` 또는 `API_SERVER_PORT`). 포트 충돌 시 exit 대신 재시도하므로 PM2 재시작 루프는 완화됩니다. CMD가 반복해서 열렸다 닫혔다 하면 **8장 안전 재기동**으로 정리하세요.
- **discord-operator**: api-server 호출은 `API_SERVER_URL`(기본 `http://localhost:3100`) 사용. .env 또는 ecosystem에서 일치시키세요.
- **api-server**: market-bot 호출은 `MARKET_BOT_URL` 사용. 리팩터 스택에서는 ecosystem.refactor.config.cjs에서 `http://localhost:3001` 로 고정( market-bot 포트 3001). .env에 `MARKET_BOT_URL=http://localhost:3000` 이 있으면 레거시( server.js 3000)용이며, pm2:refactor 시에는 ecosystem 설정이 우선됩니다.
- **로그 확인**: `logs/pm2-*-error.log` 에서 `Port 3100 already in use`, `api-server 연결 실패`, `api non-OK response` / `fetch failed`(→ market-bot 미연동 시 503), `interaction.isChatInputCommand is not a function` 등이 있으면 해당 항목 수정 후 재기동합니다.

### 9-1. 디스코드 버튼 전수 — API 경로 및 원인 정리

버튼 반 이상이 동일 원인(예: market-bot 미연동)으로 실패할 수 있음. 아래는 **버튼 → api-server 경로 → api-server 동작(proxy=market-bot 호출, direct=api-server 자체 처리)**.

| 버튼(키) | API 경로 | api-server 동작 | 비고 |
|----------|----------|-----------------|------|
| 엔진 가동 | POST /api/engine/start | **proxy** | market-bot 3001 필요 |
| 즉시 정지 | POST /api/engine/stop | **proxy** | 동일 |
| 현재 상태 | GET /api/status, /api/services-status | **proxy** + direct | status는 proxy |
| 현재 수익률 | GET /api/pnl | **proxy** | |
| 전체 매도 | POST /api/sell-all | **proxy** | |
| 경주마 ON/OFF | POST /api/race-horse-toggle | **proxy** | |
| 기준 완화 / 연장 | GET /api/relax-status, POST /api/relax, /api/relax-extend | **proxy** | |
| 초공격 scalp / 중지 / 연장 | POST /api/independent-scalp-* | **proxy** | |
| 현재전략 | GET /api/strategy-config | direct | |
| 전략(SAFE 등) | POST /api/strategy-mode | direct | |
| 최근스캘 | GET /api/strategy-status | direct | |
| 최근체결 | GET /api/strategy-status | direct | |
| AI 타점 분석 | GET /api/ai_analysis | **proxy** | |
| 시황 요약 | GET /api/analyst/summary | direct | |
| 급등주 분석 | GET /api/analyst/scan-vol | direct | |
| 주요지표 | GET /api/analyst/indicators | direct | |
| 거래 부재 진단 / 로직 수정안 제안 | GET /api/analyst/diagnose_no_trade, suggest_logic | **proxy** | |
| 조언자의 한마디 / 하루치 로그 / API 사용량 | GET /api/analyst/advisor_one_liner, daily_log_analysis, api_usage_monitor | **proxy** | |
| 헬스 | GET /api/health | direct | |
| 비상 제어(확인 후) | POST /api/admin/cleanup-processes, force-kill-bot | direct | |
| 시스템 업데이트 / 프로세스 재기동 | POST /api/admin/git-pull-restart, simple-restart | **proxy** | |

- **proxy** 로 표시된 버튼이 한꺼번에 실패하면 → **market-bot 미기동 또는 MARKET_BOT_URL 불일치(기본 3001)** 가 원인. `pm2 list` 로 market-bot online 확인, ecosystem의 `MARKET_BOT_URL: 'http://localhost:3001'` 확인.
- **direct** 만 실패하면 → api-server 자체(3100) 또는 api-server 내부 서비스(Gemini, Upbit 등) 점검.
- 로그에서 `panel button failed` + `key` 로 어느 버튼에서 실패했는지 확인 가능.

---

## 10. taskkill 시 "액세스가 거부되었습니다" / 좀비 Node 프로세스

- **원인**: 일부 `node.exe`는 다른 사용자(관리자·SYSTEM) 또는 보안 프로그램으로 보호되어 일반 CMD에서는 종료되지 않을 수 있습니다.
- **해결 순서**:
  1. **PM2 정리**: `npm run pm2:refactor:stop` → `pm2 kill` (PM2가 띄운 프로세스 정리).
  2. **관리자 CMD에서 taskkill**: CMD를 **관리자 권한으로 실행**한 뒤 `taskkill /F /IM node.exe` 실행. 그래도 특정 PID만 실패하면 `taskkill /F /PID <해당PID>` 로 그 프로세스만 종료 시도.
  3. **재기동**: 10초 정도 대기 후 `npm run pm2:refactor` 또는 `npm run pm2:refactor:safe-restart` 로 다시 기동.
- **관리자 CMD가 필요한 경우**: "액세스가 거부되었습니다"가 나오면 **관리자 권한으로 CMD 열기** → 동일 명령 재실행.
- **CMD가 반복해서 열렸다 닫혔다 할 때**: 9장·8장대로 `pm2 kill` 후 10초 대기, 한 번만 `npm run pm2:refactor` 또는 `npm run pm2:refactor:safe-restart` 실행하세요.
