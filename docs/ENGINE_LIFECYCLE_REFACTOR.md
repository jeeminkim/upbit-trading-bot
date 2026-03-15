# 매매 엔진 수동 Lifecycle 리팩터 요약

**원칙: 서비스 기동 ≠ 매매 엔진 기동. trading-engine 은 명시적 사용자 액션으로만 시작.**

---

## 1. 현재 왜 자동 시작되고 있었는지 원인

- **원인**: `src/apps/trading-engine/src/index.ts` 모듈이 **로드되는 즉시** 아래가 실행됨.
  - `setInterval(runCycle, CYCLE_MS);` — 1초마다 runCycle 실행
  - `runCycle();` — 최초 1회 즉시 실행
  - 그 결과 `[trading-engine] cycle started (server.js fetchAssets + runScalpCycle)` 로그가 api-server 기동 직후 출력됨.
- api-server 는 `listen` 성공 후 `require('../../trading-engine/src/index')` 로 trading-engine 을 로드하므로, **서버가 뜨자마자** 루프가 돌기 시작함.
- 추가로 `server.js` 를 **메인으로** 실행할 때는 `server.listen()` 콜백 안에서 `tradingEngine.start(getTradingEngineCallbacks())` 를 호출해 도메인 엔진까지 자동 기동됨.

---

## 2. 자동 start 제거한 코드

| 위치 | 변경 내용 |
|------|------------|
| **src/apps/trading-engine/src/index.ts** | 최상위 `setInterval(runCycle, CYCLE_MS);` 및 `runCycle();` 제거. 대신 `ENGINE_STARTED` 구독 시에만 `startLoop()`(setInterval + runCycle 1회), `ENGINE_STOPPED` 구독 시 `stopLoop()`(clearInterval) 호출. 로드 시 로그만: `[trading-engine] loaded (cycle starts only on ENGINE_STARTED)`. |
| **server.js** | `server.listen()` 콜백 내 `tradingEngine.start(getTradingEngineCallbacks());` 제거. 대신 `[server] 매매 엔진은 Discord/API에서 시작 버튼으로만 기동됩니다 (자동 시작 없음).` 로그만 출력. |

---

## 3. EngineControlService 설계

- **파일**: `src/packages/core/src/EngineControlService.ts`
- **역할**: 엔진 lifecycle 단일 소스. 상태 보유 및 start/stop 제어.
- **상태**: `status` ('STOPPED' | 'STARTING' | 'RUNNING' | 'STOPPING'), `startedAt`, `stoppedAt`, `updatedBy`, `lastReason`.
- **API**:
  - `getState()`: 현재 상태 스냅샷 반환.
  - `startEngine(updatedBy)`: RUNNING/STARTING 이면 no-op 및 `{ started: false, noop: true, message: '이미 실행 중입니다.' }`. STOPPED 이면 STARTING → RUNNING 전이, `EngineStateService.setBotEnabled(true)`, `ENGINE_START_REQUESTED` / `ENGINE_STARTED` 발행, `{ started: true, message: '...' }`.
  - `stopEngine(updatedBy)`: STOPPED/STOPPING 이면 no-op 및 `{ stopped: false, noop: true, message: '이미 정지 상태입니다.' }`. RUNNING 이면 STOPPING → STOPPED 전이, `setBotEnabled(false)`, `ENGINE_STOP_REQUESTED` / `ENGINE_STOPPED` 발행, `{ stopped: true, message: '...' }`.
- **전이**: STOPPED → STARTING → RUNNING, RUNNING → STOPPING → STOPPED. 중복 start/stop 은 no-op.

---

## 4. Discord 시작/정지 버튼 연결 방식

- **슬래시 명령**: `/engine start`, `/engine stop`, `/engine status`
  - start: `POST /api/engine/start` (body: `userId`, `updatedBy: 'discord'`). 응답 `noop: true` 이면 이미 실행 중 메시지 표시.
  - stop: 확인 플로우 후 `POST /api/engine/stop`. 응답 `noop: true` 이면 이미 정지 상태 메시지 표시.
  - status: `GET /api/engine-status` 호출 후 상태/시작·정지 시각/변경 주체/전략 모드 표시.
- **버튼**: 엔진 정지 확인 버튼(confirm_)에서 동일하게 `POST /api/engine/stop` 호출.
- EventBus 는 api-server 쪽 EngineControlService 에서만 발행. discord-operator 는 더 이상 `ENGINE_STARTED` / `ENGINE_STOPPED` 를 직접 emit 하지 않음.

---

## 5. API / Dashboard 상태 조회 반영

- **GET /api/engine-status**: `EngineControlService.getState()` + `runtimeStrategyConfig.getState().mode` 로 다음 반환.
  - `status`, `startedAt`, `stoppedAt`, `updatedBy`, `lastReason`, `runtimeMode`
- **콘솔 system_status**: `buildConsoleSegments()` 에서 `engine` = `EngineControlService.getState().status`, `engineStartedAt`, `engineStoppedAt`, `engineUpdatedBy` 포함.
- **Dashboard (console.html)**: SYSTEM STATUS 에 engine, engine startedAt, stoppedAt, updatedBy 표시.

---

## 6. EventBus / AuditLog 반영

- **EventBus**: `ENGINE_START_REQUESTED`, `ENGINE_STARTED`, `ENGINE_STOP_REQUESTED`, `ENGINE_STOPPED` (shared types 에 추가). payload 에 `status`, `updatedBy`, `at` 등 포함.
- **AuditLog**: api-server 의 `/api/engine/start`·`/api/engine/stop` 에서 기존처럼 `engine_start` / `engine_stop` 기록. no-op 인 경우도 success 로 기록해 구분 가능.

---

## 7. PM2 재기동 시 STOPPED 보장 방식

- **EngineControlService** 초기 상태는 `status: 'STOPPED'`.
- 프로세스 기동 시 **ENGINE_STARTED 를 발행하는 코드가 없음**. start 는 오직 `POST /api/engine/start` → `EngineControlService.startEngine()` 경로에서만 발생.
- trading-engine 모듈은 로드 시 `setInterval` 을 걸지 않고, `ENGINE_STARTED` 구독만 등록. 따라서 PM2 restart / api-server 재기동 후에는 루프가 돌지 않고, **기본 상태는 항상 STOPPED**.

---

## 8. 코드 패치 포인트

| 파일 | 변경 요약 |
|------|------------|
| src/packages/shared/src/types.ts | EventType 에 `ENGINE_START_REQUESTED`, `ENGINE_STOP_REQUESTED` 추가 |
| src/packages/core/src/EngineControlService.ts | 신규. start/stop/getState, EventBus 발행 |
| src/packages/core/src/PermissionService.ts | `engine_status`: VIEWER |
| src/apps/trading-engine/src/index.ts | 자동 setInterval/runCycle 제거, ENGINE_STARTED/STOPPED 구독으로 startLoop/stopLoop |
| src/apps/api-server/src/index.ts | EngineControlService 연동, GET /api/engine-status, POST start/stop 에서 no-op 처리 및 server.discordHandlers 호출 |
| src/apps/api-server buildConsoleSegments | system_status 에 engineControl 상태 필드 추가 |
| src/apps/discord-operator | /engine start·stop 시 EventBus emit 제거, noop 메시지 반영, /engine status 추가 |
| server.js | listen 콜백에서 tradingEngine.start() 제거 |
| public/console.html, console.js | engine startedAt, stoppedAt, updatedBy 표시 |

---

## 9. 운영자 재기동 후 체크리스트

- [ ] PM2 로 서비스 기동 후 **engine status = STOPPED** (GET /api/engine-status 또는 Dashboard SYSTEM STATUS).
- [ ] Discord 시작 버튼/명령 누르기 전에는 **trading cycle 가 돌지 않음** (로그에 `[trading-engine] cycle started` 가 없음).
- [ ] Discord **시작** 누르면 **RUNNING** 전환, 로그에 `[trading-engine] cycle started (explicit start)` 1회.
- [ ] Discord **정지** 누르면 **STOPPED** 전환, 로그에 `[trading-engine] cycle stopped`.
- [ ] 이미 RUNNING 일 때 start 요청 시 **no-op**, "이미 실행 중입니다." 메시지.
- [ ] 이미 STOPPED 일 때 stop 요청 시 **no-op**, "이미 정지 상태입니다." 메시지.
- [ ] **/api/engine-status** 또는 Dashboard 에서 **status, startedAt, stoppedAt, updatedBy** 확인 가능.
- [ ] **PM2 restart** 후 다시 **STOPPED** 로 시작하는지 확인.
- [ ] **전략 모드(RuntimeStrategyConfig)** 는 그대로 동작 (전략 모드 버튼/슬래시 유지).
- [ ] 자동매매는 **명시적 사용자 액션(시작 버튼/슬래시)** 으로만 시작됨.
