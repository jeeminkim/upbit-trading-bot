# 장애 복구 수정 요약 (운영 안정화 패치)

이 문서는 **api-server 재시작 루프**, **ADMIN_ID 미설정**, **Upbit getTickers timeout 반복** 세 가지 구동 장애에 대한 수정 내용과 운영자 체크리스트를 정리한 것이다. 전략 모드 / RuntimeStrategyConfig / Explain 로직은 변경하지 않았다.

---

## 1. .server.lock 문제

### 원인

- 기존: lock 파일이 **존재만** 하면 2분 미만일 때 무조건 `process.exit(1)`. PM2 재시작 시 이전 프로세스가 정상 종료되지 않아 **stale lock**이 남고, 새 프로세스가 매번 같은 이유로 종료되어 재시작 루프에 빠짐.

### Stale lock / Active instance 구분

- **Stale lock**: lock에 적힌 PID가 더 이상 살아있지 않거나, lock의 `updatedAt`이 2분(120초) 이상 지난 경우. → lock 파일 삭제 후 서버 시작.
- **Active instance**: lock에 적힌 PID가 실제로 동작 중이고, 동일 cwd/앱으로 판단되는 경우. → 시작 거부 후 종료.

### lock 처리 코드 수정

- **신규**: `lib/serverLock.js`
  - lock 파일 내용: `pid`, `hostname`, `cwd`, `appName`, `createdAt`, `updatedAt` (JSON).
  - `tryAcquire(lockPath)`: lock 없음 → 기록 후 획득. lock 있음 → 파싱 후 PID 생존·동일 cwd 검사, 2분 초과 시 stale로 제거 후 기록.
  - `release(lockPath)`: **자기 PID가 쓴 lock만** 삭제.
- **수정**: `server.js`
  - `ensureSingleInstance()`에서 `serverLock.tryAcquire(SERVER_LOCK_PATH)` 사용.
  - 획득 실패 시 `[fatal][server] Another active instance detected. Startup aborted.` + `existing_pid`, `lock_file`, `cwd` 로그 후 `process.exit(1)`.
  - Stale 제거 시: `[server] Stale .server.lock detected. Removing stale lock and continuing startup.`
  - `exit` / `SIGINT` / `SIGTERM` 시 `serverLock.release(SERVER_LOCK_PATH)` 호출.

---

## 2. ADMIN_ID 미설정 안내 개선

- **시작 시**: `server.js`에서 ADMIN_ID/ADMIN_DISCORD_ID/DISCORD_ADMIN_ID/SUPER_ADMIN_ID가 모두 없으면:
  - `[config][warn] ADMIN_ID is not set.`
  - `[config][warn] Strategy mode change via Discord may not work as expected for admin-only operations.`
  - `[config][warn] Please set ADMIN_ID or ADMIN_DISCORD_ID in environment variables.`
- **상태 API**: `/api/health` 응답에 `adminConfigPresent`(boolean), `adminConfigWarning`(string | null) 추가. 대시보드 `console:system_status`에도 동일 필드 포함.
- **대시보드**: `console.html` SYSTEM STATUS 카드 하단에 `adminConfigWarning`이 있으면 노란색 경고 문구 표시.
- **Discord**:
  - 전략 모드 버튼/슬래시에서 권한 없을 때: **ADMIN_ID 등이 하나도 없으면**  
    `관리자 ID 미설정으로 판별 불가. .env에 ADMIN_ID 또는 ADMIN_DISCORD_ID를 설정하세요.`  
  - **ADMIN_ID는 있는데 해당 유저가 아닌 경우**  
    `권한 없음 (ADMIN만 전략 모드 전환이 가능합니다)` / `권한 없음 (AUTH_INSUFFICIENT_ROLE)`.

---

## 3. Upbit getTickers timeout 안정화

- **설정 분리**: `lib/upbit.js`에서 `UPBIT_HTTP_TIMEOUT_MS` 환경변수 사용. 미설정 시 기본 **8000ms**. `.env.example`에 `# UPBIT_HTTP_TIMEOUT_MS=10000` 주석 추가.
- **재시도·백오프**: `getTickers` / `getOrderbook` 공통으로 최대 **3회** 시도, 실패 시 **500ms → 1000ms → 2000ms** 대기 후 재시도.
- **로그 노이즈 감소**: 동일 키(`getTickers` 또는 `getOrderbook`)에 대해 **30초당 1회**만 전체 메시지 출력. 그 사이 발생한 건은 건수만 누적 후, 다음 출력 시 `Upbit getTickers error repeated N times in last 30s. Last: ...` 형태로 한 줄 로그.
- **프로세스 생존**: timeout/재시도 실패 시에도 **빈 배열 반환**만 하고 프로세스는 종료하지 않음. 해당 사이클만 skip 후 다음 사이클 진행.
- **최종 실패 로그**: `timeout_ms`, `attempts`, `endpoint`, `markets`(개수), `error` 메시지 포함.

---

## 4. PM2 친화 로그

- **Startup summary**: api-server가 `listen` 성공 시 한 줄 출력  
  `[startup] app=api-server port=3000 adminConfigPresent=false runtimeMode=SAFE lockFile=.server.lock`
- **심각도 prefix**:  
  - `[fatal]`: .server.lock로 인한 중복 인스턴스 종료, EADDRINUSE로 인한 api-server 종료.  
  - `[warn]`: ADMIN_ID 미설정, Upbit timeout(rate-limited).  
  - `[info]` / 기존 `[server]`, `[api-server]` 유지.
- **재시작 루프 시**: api-server가 곧바로 죽는 경우, server.js 쪽에서 `[fatal][server] Another active instance detected. Startup aborted.` 또는 stale 제거 로그로 원인 확인 가능.

---

## 5. 코드 패치 포인트

| 구분 | 파일 | 변경 요약 |
|------|------|-----------|
| Lock | `lib/serverLock.js` | 신규. JSON lock, stale 판별, tryAcquire/release. |
| Lock | `server.js` | serverLock 사용, exit/SIGINT/SIGTERM 시 release. |
| ADMIN | `server.js` | ADMIN 미설정 시 [config][warn] 3줄. |
| ADMIN | `src/apps/api-server/src/index.ts` | getAdminConfigStatus(), /api/health·system_status에 adminConfigPresent/Warning. |
| ADMIN | `src/apps/discord-operator/src/index.ts` | 전략 모드 권한 거부 시 메시지 분기(미설정 vs 권한 없음). |
| ADMIN | `public/console.html`, `public/js/console.js` | sys-admin-warn 표시. |
| Upbit | `lib/upbit.js` | UPBIT_HTTP_TIMEOUT_MS, 재시도·백오프, rateLimitErrorLog. |
| Upbit | `.env.example` | UPBIT_HTTP_TIMEOUT_MS 주석 추가. |
| PM2 로그 | `src/apps/api-server/src/index.ts` | [startup] 한 줄, EADDRINUSE 시 [fatal]. |

---

## 6. 운영자 재기동 후 체크리스트

다음 항목을 확인할 수 있어야 한다.

- [ ] **pm2 status** 에서 api-server / discord-operator / market-bot 모두 **online**.
- [ ] api-server가 **.server.lock 때문에 재시작 루프에 빠지지 않음** (stale lock은 자동 제거 후 기동).
- [ ] **GET /api/strategy-config** 정상 응답 (mode, profile, threshold 등).
- [ ] **ADMIN 미설정 시**:  
  - 로그에 `[config][warn] ADMIN_ID is not set.` 등 3줄 경고.  
  - GET /api/health 에 `adminConfigPresent: false`, `adminConfigWarning` 문자열 존재.  
  - 대시보드 SYSTEM STATUS 하단에 노란색 경고 문구 표시.  
  - Discord 전략 모드 버튼/슬래시 시 "관리자 ID 미설정으로 판별 불가…" 메시지.
- [ ] **Upbit timeout 발생 시**:  
  - 프로세스가 **죽지 않고** 다음 사이클로 진행.  
  - 동일 timeout 에러가 **초당 반복 출력되지 않고**, 30초당 1회(또는 repeated N times) 수준으로만 로그.
- [ ] 필요 시 **UPBIT_HTTP_TIMEOUT_MS=10000** 등으로 .env에 설정 가능.

위가 모두 만족되면 구동 장애 복구 패치가 정상 반영된 상태로 판단하면 된다.
