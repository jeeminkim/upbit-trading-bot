# 엔진 상태 분리 및 Graceful Shutdown

## 1. 현재 문제 원인 분석

### 왜 PM2 기동 직후 [엔진 가동]이 "이미 실행 중"으로 뜨는가

- **레거시(server.js 단일 프로세스)**: 초기값은 `EngineStateStore.init({ botEnabled: false })`로 이미 false이며, 기존 `engineStart`는 **이미 실행 중인지 검사하지 않고** 무조건 Upbit 검증 후 `state.botEnabled = true`만 설정했습니다. 따라서 레거시만 쓸 경우 "이미 실행 중" 메시지 자체가 나오지 않는 경로였습니다.
- **리팩터 스택(api-server + discord-operator + market-bot)**: `EngineControlService.startEngine()`이 `status === 'RUNNING' || status === 'STARTING'`이면 `noop: true, message: '이미 실행 중입니다.'`를 반환합니다. 문제가 된다면 (1) 프로세스 재시작 후 어딘가에서 status가 RUNNING으로 복원되거나, (2) 버튼 연타로 두 번째 요청이 먼저 처리되거나, (3) 다른 코드가 `startEngine()`을 호출하는 경우입니다. **EngineControlService 상태는 파일로 복원하지 않으며**, 모듈 로드 시 `status: 'STOPPED'`로 고정됩니다. 따라서 “패널 올라오자마자 첫 클릭에 이미 실행 중”이 나온다면, **프로세스 생존(processAlive)과 엔진 가동(engineRunning)을 같은 것으로 착각한 UI/로직**이 있거나, **엔진 가동 상태를 복원하는 코드**가 있을 가능성이 있습니다.

### 프로세스 상태와 엔진 상태가 어떻게 혼동되는지

- **processAlive**: Node 프로세스가 살아 있음 (PM2로 띄우면 true).
- **engineRunning (= state.botEnabled / EngineControlService.status === 'RUNNING')**: 실제 자동매매 루프가 돌고 있는지.
- 혼동 사례:
  - “프로세스가 떠 있으니까 엔진도 켜져 있다”고 가정하고, 시작 버튼을 “이미 켜져 있음”으로 처리하는 경우.
  - 상태 메시지에 “엔진 구동 중”이라고만 하고, **실제로는 중지 상태**인데 프로세스만 살아 있어 보이는 경우.
  - 재기동 후 **engineRunning을 true로 복원**하는 코드가 있으면, 사용자가 가동 버튼을 누르지 않았는데도 “이미 실행 중”으로 나올 수 있음.

이번 수정으로 **엔진은 항상 기본 OFF**, **시작/중지 버튼은 engineRunning만 보고 동작**하도록 명확히 했습니다.

---

## 2. 수정 파일 목록

| 파일 | 변경 내용 |
|------|------------|
| `server.js` | EngineStateStore에 lastEngineStartedAt, lastEngineStoppedAt, lastShutdownReason, shutdownInProgress 추가. engineStart/engineStop noop 처리 및 반환 메시지 통일. buildCurrentStateEmbed에 “자동매매 엔진 상태” 한 줄·마지막 시작/중지 시각·종료 사유 추가. Graceful shutdown 훅(SIGINT/SIGTERM), _releaseLockRef. |
| `lib/discordBot.js` | engine_start/engine_stop 버튼 응답 메시지(noop 시 “이미 실행 중”/“이미 중지 상태”). sendShutdownMessage(4초 타임아웃) 추가. |
| `domain/state/EngineStateStore.js` | (init 쪽은 server.js에서 호출 시 넘기는 객체에 필드 추가. Store 자체는 수정 없음) |
| `src/packages/core/src/EngineControlService.ts` | [ENGINE_STATE] 로그(initial state, start/stop requested, success, skipped). 메시지 문구 “자동매매 엔진이 시작되었습니다.” / “자동매매 엔진을 중지했습니다.” / “이미 중지 상태입니다.” |
| `dist-refactor/packages/core/src/EngineControlService.js` | 위와 동일 내용 반영(빌드 산출물). |

---

## 3. 각 파일별 수정 목적

- **server.js**: (1) 엔진 생명주기 상태 확장 (lastEngineStartedAt, lastEngineStoppedAt, lastShutdownReason, shutdownInProgress). (2) engineStart: shutdown 중이면 거절, 이미 botEnabled면 noop + “이미 실행 중입니다.”, 성공 시 “자동매매 엔진이 시작되었습니다.” 및 [ENGINE_STATE] 로그. (3) engineStop: 이미 중지면 noop + “이미 중지 상태입니다.”, 아니면 중지 후 “자동매매 엔진을 중지했습니다.” (4) 현재 상태 임베드에 “자동매매 엔진 상태: 🔴 중지됨”/“🟢 가동 중” 한 줄과 마지막 시작/중지 시각·종료 사유. (5) Graceful shutdown: SIGINT/SIGTERM 시 shutdownInProgress 설정, 엔진 중지, Discord 종료 메시지 전송(최대 4초), lock 해제 후 process.exit(0).
- **lib/discordBot.js**: (1) engine_start 시 result.noop이면 “이미 실행 중입니다.” 등 서버에서 내려준 메시지 그대로 표시, success이고 noop이 아닐 때만 채널 브로드캐스트. (2) engine_stop 시 서버 반환 메시지 표시. (3) sendShutdownMessage: 종료 직전 메시지 전송, Promise.race로 4초 타임아웃.
- **EngineControlService (TS/JS)**: (1) 모듈 로드 시 [ENGINE_STATE] initial state (status: STOPPED). (2) start/stop 시 requested, success, skipped 로그. (3) 사용자-facing 메시지를 “자동매매 엔진이 시작되었습니다.” / “자동매매 엔진을 중지했습니다.” / “이미 중지 상태입니다.”로 통일.

---

## 4. 실제 코드 수정 요약

### engineRunning 상태 분리

- `state.botEnabled` = 엔진 가동 여부 (프로세스 생존과 무관).
- 부팅 시: `botEnabled: false`, `lastEngineStartedAt`/`lastEngineStoppedAt`/`lastShutdownReason`/`shutdownInProgress` 초기화.
- 재기동 후에도 `engineRunning`은 **복원하지 않고** 항상 false로 시작.

### 엔진 시작/중지 버튼 처리

- **engineStart**: `state.shutdownInProgress`면 거절. `state.botEnabled === true`면 noop, `{ success: false, noop: true, message: '이미 실행 중입니다.' }`. 아니면 Upbit 검증 후 `botEnabled = true`, `lastEngineStartedAt` 갱신, `{ success: true, message: '자동매매 엔진이 시작되었습니다.' }`.
- **engineStop**: `state.botEnabled === false`면 noop, `{ success: true, noop: true, message: '이미 중지 상태입니다.' }`. 아니면 tradingEngine.stop(), `botEnabled = false`, `lastEngineStoppedAt` 갱신, `{ success: true, message: '자동매매 엔진을 중지했습니다.' }`.
- Discord 쪽: `result.message`를 그대로 표시하고, engine_start는 `result.success && !result.noop`일 때만 채널에 알림.

### 현재 상태 메시지

- `buildCurrentStateEmbed`: 상단에 **자동매매 엔진 상태: 🔴 중지됨** / **자동매매 엔진 상태: 🟢 가동 중** 한 줄 (setDescription). 필드로 마지막 엔진 시작 시각, 마지막 엔진 중지 시각, 최근 종료 사유 추가.

### Graceful shutdown 훅

- `runGracefulShutdown(reason)`: `state.shutdownInProgress`면 즉시 return. 아니면 `shutdownInProgress = true`, `lastShutdownReason = reason`, 엔진이 켜져 있으면 중지, Discord로 “🛑 시스템 종료되었습니다” + Discord Operator/자동매매 엔진/종료 사유 텍스트 전송 (`sendShutdownMessage`, 최대 4초), `_releaseLockRef()`, `process.exit(0)`.
- SIGINT/SIGTERM에서만 `runGracefulShutdown('SIGINT'|'SIGTERM')` 호출 (require.main === module일 때만 등록).

### 중복 종료 방지

- `state.shutdownInProgress` (및 EngineStateStore 동기화)로 한 번만 shutdown 로직 실행.

---

## 5. 종료/재기동 시 Discord 메시지 예시

### 종료 직전 (PM2 stop / SIGTERM / SIGINT 등)

```
🛑 **시스템 종료되었습니다**

- Discord Operator: 종료 준비 완료
- 자동매매 엔진: 중지 처리 완료 / 이미 중지됨
- 종료 사유: SIGTERM
```

### 재기동 후 (기존 부팅 메시지 유지)

- “시스템 재가동 완료 🟢” 또는 “시스템 재시작 완료”
- [📊 현재 상태]에는 **자동매매 엔진 상태: 🔴 중지됨**으로 표시.

---

## 6. 테스트/검증 방법

| 항목 | 방법 |
|------|------|
| PM2 start 후 엔진 기본 상태 | `pm2 start ecosystem.config.cjs` 후 로그에 `[ENGINE_STATE] initial state: { botEnabled: false }` 확인. Discord [📊 현재 상태]에 “자동매매 엔진 상태: 🔴 중지됨” 표시 확인. |
| [엔진 가동] 버튼 | 첫 클릭 시 “자동매매 엔진이 시작되었습니다.” 및 상태가 “🟢 가동 중”으로 변경. 두 번째 클릭 시 “이미 실행 중입니다.” |
| [즉시 정지] 버튼 | 엔진 가동 중 한 번 클릭 시 “자동매매 엔진을 중지했습니다.” 및 “🔴 중지됨”. 이미 중지 상태에서 클릭 시 “이미 중지 상태입니다.” |
| PM2 stop | `pm2 stop upbit-bot` 후 Discord에 “🛑 시스템 종료되었습니다” 및 종료 사유(SIGTERM) 전송 확인. 수 초 내 프로세스 종료. |
| PM2 restart | `pm2 restart upbit-bot` 후 먼저 “시스템 종료되었습니다” 메시지, 재시작 후 “시스템 재가동 완료” 및 “자동매매 엔진 상태: 🔴 중지됨” 확인. |
| SIGTERM/SIGINT | 프로세스에 SIGTERM 또는 SIGINT 보낸 뒤, Discord 종료 메시지와 정상 exit 확인. |

---

## 7. 롤백 포인트

- **server.js**: EngineStateStore.init 확장 필드 제거, engineStart/engineStop에서 noop/메시지 분기 제거하고 기존처럼 단순 설정만 복원. runGracefulShutdown 제거 후 SIGINT/SIGTERM에서 기존처럼 releaseLock + process.exit(0)만 호출.
- **lib/discordBot.js**: engine_start/engine_stop 응답을 기존 문구로 되돌리고, sendShutdownMessage 제거.
- **EngineControlService (TS/JS)**: logEngineState 및 initial state 로그 제거, 메시지 문구를 기존 “매매 엔진을 시작/정지했습니다.” 등으로 복원.
- **buildCurrentStateEmbed**: setDescription 및 마지막 시작/중지/종료 사유 필드 제거, “매매 엔진 상태” 필드명/문구만 유지.

이렇게 하면 동작은 “엔진 상태 분리·graceful shutdown” 적용 이전과 동일하게 돌아갑니다.
