# 모드·안전장치 엄격 재검증 (3단계 분류)

코드 기준으로 4가지 항목을 재검증하고, **확실히 안전** / **주의 필요** / **위험** 으로 분류함.

---

## 1. 모드 종료 후 롤백 누락 가능성

### 1.1 금액 비중

| 항목 | 코드 위치 | 동작 | 판정 |
|------|-----------|------|------|
| 경주마 50% | `server.js` 1517: `use50PercentOrder = state.raceHorseActive && isRaceHorseTimeWindow` | 매 틱 `state.raceHorseActive`를 **직접 읽음**. 경주마 OFF 시 다음 틱부터 false. | **확실히 안전** |
| getBuyOrderAmountKrw | `scalpEngine.js` 278: `use50Percent = isRaceHorseMode && isRaceHorseTimeWindow` | 호출 시마다 인자로 받은 `isRaceHorseMode`(= state.raceHorseActive) 사용. 별도 캐시 없음. | **확실히 안전** |

- **결론**: 금액 비중은 상태값에만 의존하므로, 모드 종료 시 별도 롤백 없이도 다음 틱부터 자동 원복됨.

---

### 1.2 진입 threshold (entry_score_min, strength_threshold)

| 항목 | 코드 위치 | 동작 | 판정 |
|------|-----------|------|------|
| 경주마 OFF 시 | `StrategyManager.js` 51, 70: `profile = { ...baseProfile, ...(raceHorseActive ? RACE_HORSE_OVERRIDES : {}) }` | `setRaceHorseActive(false)` 시 profile에서 RACE_HORSE_OVERRIDES 제거. `getProfile()`은 항상 현재 profile 반환. | **확실히 안전** |
| 완화 모드 | `StrategyManager.getProfile()` | **RELAXED_OVERRIDES를 전혀 병합하지 않음.** `relaxedUntil`/`getRelaxedModeRemainingMs()`와 무관. | **위험** (적용 자체가 없어 “롤백”이 아니라 “미적용” 문제) |
| AI aggressive | `scalpEngine.js` 314–322: `getAggressiveSymbols()` | `data.until > now`인 것만 반환. 만료 시 목록에서 제거. | **확실히 안전** |

- **결론**: 경주마·aggressive는 롤백 정상. 완화 모드는 getProfile()에 반영이 없어, “종료 후 롤백”이 아니라 “활성 시에도 진입 기준이 완화되지 않음”이 문제.

---

### 1.3 Cooldown

| 항목 | 코드 위치 | 동작 | 판정 |
|------|-----------|------|------|
| 메인 cooldown | `orchestrator.js` 192–196: `recordEntry(symbol, strategy)` → `lastEntryBySymbol[symbol] = now` | 메인/오케스트레이터가 **매수 체결 시에만** 호출. | - |
| 초 scalp 매수 시 | `scalpRunner.js` 166–177: `ctx.recordTrade(...)` 만 호출 | **orchestrator.recordEntry() 호출 없음.** | **주의 필요** |

- **결론**: 초 scalp가 매수한 심볼은 `lastEntryBySymbol`에 기록되지 않음. 초 scalp 종료 후 메인으로 전환되면, 해당 심볼에 대해 30분 cooldown이 적용되지 않아 **즉시 재진입 가능**. (동일 틱 중복 주문은 아님.)

---

### 1.4 Aggressive flag

| 항목 | 코드 위치 | 동작 | 판정 |
|------|-----------|------|------|
| AI 가중치 (aggressiveSymbols) | `scalpEngine.js` 302–322: `setAggressiveSymbol` / `getAggressiveSymbols` | `data.until > now` 만 유효. 만료 시 삭제. | **확실히 안전** |
| strategySummary.aggressive_mode | DB/설정에서 로드, 표시용 | 진입 금액/비중 계산에 사용되지 않음 (getBuyOrderAmountKrw는 raceHorse·aggressiveSymbols만 사용). | **확실히 안전** |
| scalpState.isRaceHorseMode | `scalpState.js` 84: `stop()` 시 `this.isRaceHorseMode = false` | 초 scalp 정지 시 clear. | **확실히 안전** |

---

### 1.5 Scalp 전용 파라미터

| 항목 | 코드 위치 | 동작 | 판정 |
|------|-----------|------|------|
| TAKE_PROFIT_PCT, STOP_LOSS_PCT, MIN_TRADE_INTERVAL_MS | `scalpRunner.js` 상수 | `scalpRunner.tick()` / `tickExit()` 내부에서만 사용. `if (!scalpState.isRunning || ...) return` 으로 진입 차단되면 이 로직 자체가 실행되지 않음. | **확실히 안전** |
| scalpState.activePosition | `scalpState.stop()` 에서 `this.activePosition = null` 추가됨 | 만료/정지 시 clear. 메인 runExitPipeline이 해당 마켓 담당. | **확실히 안전** (이미 수정 반영) |

---

### 1항목 종합

| 구분 | 판정 |
|------|------|
| **확실히 안전** | 금액 비중, 경주마 threshold, AI aggressive, scalp 전용 파라미터, activePosition 정리 |
| **주의 필요** | 초 scalp 매수 시 orchestrator cooldown(lastEntryBySymbol) 미기록 → 스캘프 종료 후 같은 심볼 즉시 재진입 가능 |
| **위험** | 완화 모드: getProfile()에 RELAXED_OVERRIDES 미병합 → 진입 기준 완화가 아예 적용되지 않음 (롤백 이전의 “미적용” 문제) |

---

## 2. 중복 주문 위험 (같은 market, 같은 시점)

### 2.1 주문 발생 경로

- **경로 1 (메인)**  
  `server.js` 1497–1626: `if (state.botEnabled && orchResult.action === 'ENTER' && orchResult.signal && ...)`  
  → 그 안에서 `if (scalpState.priorityOwner === 'SCALP')` 이면 **전체 블록 스킵** (주문 없음).  
  → 주문은 `priorityOwner !== 'SCALP'` 일 때만 실행.

- **경로 2 (초 scalp)**  
  `server.js` 1629–1643: `if (state.scalpMode && scalpState.isRunning)` 일 때만 `scalpRunner.tick(ctx)` 호출.  
  `scalpState.activate()` 시 `priorityOwner = 'SCALP'` 이고 `isRunning = true`.  
  `stop()` 시 `priorityOwner = 'MAIN'`, `isRunning = false`.

- **같은 틱 내 순서**  
  1) 오케스트레이터 ENTER 블록 (경로 1)  
  2) 그 다음 `if (state.scalpMode && scalpState.isRunning)` → scalpRunner.tick (경로 2)

- **상호 배타**  
  - `priorityOwner === 'SCALP'` 이면 경로 1은 스킵 → 경로 2만 실행 가능.  
  - `priorityOwner === 'MAIN'` 이면 `scalpState.isRunning` 이 false (stop()에서 함께 바뀜) → 경로 2 진입 안 함 → 경로 1만 실행 가능.  
  따라서 **같은 틱에 두 경로가 동시에 주문하는 경우 없음**.

### 2.2 모드별 정리

| 모드 | 주문 경로 | 동일 market 동시 주문 가능 여부 | 판정 |
|------|-----------|----------------------------------|------|
| 기본 엔진 | 경로 1 (orchestrator ENTER) | 경로 1은 1틱에 1심볼 1회. 경로 2와는 priorityOwner로 상호 배타. | **확실히 안전** |
| 경주마 | 경로 1과 동일 (금액/가중치만 변경) | 별도 주문 경로 없음. | **확실히 안전** |
| 완화 모드 | 경로 1과 동일 (현재는 프로필에 미반영) | 별도 주문 경로 없음. | **확실히 안전** |
| 초 scalp | 경로 2 (scalpRunner.tick) | 경로 1이 priorityOwner 때문에 스킵된 상태에서만 경로 2 실행. | **확실히 안전** |

- **결론**: **같은 market, 같은 시점에 두 경로가 동시에 주문하는 경우는 없음. 확실히 안전.**

---

## 3. 우선순위 충돌

### 3.1 특수 모드 활성화 vs Risk Gate 순서

| 단계 | 코드 위치 | 내용 |
|------|-----------|------|
| 1 | `server.js` 1452–1476 | `orchCtx` 에 `scalpState`, `profile`(=getProfile(), 모드 반영) 포함. |
| 2 | `orchestrator.tick(orchCtx)` | `scalpSignalProvider.getBestScalpSignal(scalpState, profile, entry_score_min)` 등으로 **모드가 반영된 프로필**로 시그널 평가. |
| 3 | `orchestrator.js` 79–110 | 시그널 선택 후 **riskGate.checkAll(gateCtx, signal.symbol, finalScore)** 호출. |
| 4 | `server.js` 1528–1549 | riskGate 통과 후 **canPlaceOrder(state)** → 실행. |

- **순서**: (모드 반영된) 시그널 평가 → **Risk Gate** → canPlaceOrder → 실행.  
- **판정**: Risk Gate는 “모드로 인한 진입 의도”가 나온 **뒤**에 적용되며, 통과해야만 주문으로 이어짐. **주의 필요**로 보지 않고, “의도 생성(모드) → 안전장치(risk gate) → 실행” 순서는 유지됨.  
- 다만 **초 scalp(경로 2)에는 riskGate가 없음** (이전 감사와 동일). 이 부분은 **주의 필요** (별도 항목).

### 3.2 Emergency Pause가 모든 경로를 막는지

| 경로 | PAUSE 시 동작 | 코드 근거 |
|------|----------------|-----------|
| runOneTick 전체 | **실행되지 않음** | `TradingEngine.js` 97–101: `refreshEngineMode()` 후 `mode === EMERGENCY_PAUSE` 이면 runOneTick 호출 없이 return. |
| runOneTick 내 fetchAssets / runScalpCycle / runExitPipeline / orchestrator / scalpRunner | PAUSE 시 runOneTick 자체가 호출되지 않으므로 **모두 미실행** | - |
| 수동 매수·매도, sellAll | **canPlaceOrder(state)** 로 차단 | `server.js` 1902, 1969, 2481. PAUSE/RECOVERY 시 false. |
| 오케스트레이터 ENTER (경로 1) | runOneTick 미호출 → 진입 블록 미실행. 또한 **canPlaceOrder** 로 이중 차단 | 1545, 1586 |
| 초 scalp (경로 2) | runOneTick 미호출 → scalpRunner.tick 미호출 | - |

- **판정**: Emergency Pause 시 **모든 주문 경로가 실제로 호출되지 않거나 canPlaceOrder로 차단됨. 확실히 안전.**

### 3.3 Legacy vs Signal-Engine 최종 승자

| 단계 | 코드 위치 | 내용 |
|------|-----------|------|
| 시그널/파이프라인 | `server.js` 1006–1021 | `if (signalEngineResult && signalEngineResult.byMarket[market])` → 해당 마켓은 **signal-engine 결과** 사용, else → **legacy runEntryPipeline** 사용. 마켓당 **한 소스만** 사용. |
| 오케스트레이터 | `orchestrator.tick` | `scalpSignalProvider.getBestScalpSignal(state.scalpState, ...)` → 이미 runScalpCycle에서 채워진 `state.scalpState` 사용. |
| 주문 시 사용값 | `server.js` 1510–1524 | `state.scalpState[market]` 의 pipeline(score, quantityMultiplier 등) 사용. 위에서 정해진 단일 pipeline. |

- **판정**: 마켓별로 legacy **또는** signal-engine 중 하나만 선택되고, 그 결과가 state.scalpState와 주문까지 일관되게 사용됨. **최종 승자는 “마켓별로 선택된 단일 pipeline”. 확실히 안전.**

---

### 3항목 종합

| 구분 | 판정 |
|------|------|
| **확실히 안전** | Emergency Pause가 모든 주문 경로 차단, Legacy vs Signal-Engine 단일 승자 구조 |
| **주의 필요** | 초 scalp 경로에는 riskGate 미적용 (daily loss, ws_lag, cooldown 등). 메인과 안전장치 수준 불일치. |

---

## 4. 시간 제한 강제성

### 4.1 expireAt/endTime 저장 후 실제 체크 여부

| 모드 | 저장 위치 | 체크 위치 | 만료 시 내부 정리 | 판정 |
|------|-----------|-----------|-------------------|------|
| 완화 | `StrategyManager.relaxedUntil` | `getRelaxedModeRemainingMs()` 호출 시 `remaining <= 0` 이면 `relaxedUntil = 0` 대입 | 호출 시마다 만료면 0으로 정리 | **확실히 안전** |
| 초 scalp | `scalpState.endTime` | `scalpRunner.tick()` 진입 시 `scalpState.checkExpiry()` → `Date.now() > this.endTime` 이면 `stop()` | `stop()` 에서 endTime=null, isRunning=false, activePosition=null | **확실히 안전** |
| 경주마 | 시간대만 사용 (08:55~09:10, 09:00~10:00) | `updateRaceHorseFromSchedule()` 매 틱. 단, **userRequestedRaceHorse** 이면 시간대 밖에서도 OFF 안 함 | - | **위험** (시간 제한이 “사용자 ON” 시 무력화됨) |

- **expireAt만 저장하고 체크를 안 하는 구간**: 코드 상 **없음**. 완화·초 scalp는 만료 시 체크 및 내부 정리 존재.  
- **경주마**는 “만료 시각”이 아니라 “시간대 + 사용자 플래그”라, 사용자 ON 시 **자동 종료가 되지 않음** → 시간 제한 강제성 위반으로 **위험** 분류.

### 4.2 UI/Discord 상 종료인데 내부 값이 남는 경우

| 모드 | persist/load | UI·내부 동기화 | 판정 |
|------|-------------|----------------|------|
| 완화 | `getCurrentSystemState()`: `relaxedRemaining > 0` 일 때만 soft_criteria.active/endTime 설정. 만료 시 0 → active false, endTime null | `getRelaxedModeRemainingMs()` 가 만료 시 relaxedUntil=0 으로 정리하므로, 다음 persist부터 active false. | **확실히 안전** |
| 초 scalp | `getCurrentSystemState()`: `st?.isRunning && scalpRemaining > 0` 일 때만 scalp_mode.active true. stop() 후 isRunning false → persist 시 active false | 부팅 시 `EngineStateStore.update({ scalpMode: scalpState.isRunning })` (688행). 재시작 시 scalpState 기본값은 isRunning false → scalpMode false. | **확실히 안전** |
| 경주마 | state.raceHorseActive 는 StrategyManager와 매 틱 동기화. persist에는 “경주마 예약”만 저장(race_horse_scheduler_enabled). | 사용자 ON 후 시간대가 지나도 raceHorseActive 가 true 로 남을 수 있음 (userRequestedRaceHorse). UI는 “활성”으로 보이지만, 의도는 “시간 제한”인데 무기한 유지됨. | **위험** (UI/의도와 내부 동작 불일치) |

- **결론**:  
  - **확실히 안전**: 완화·초 scalp는 만료 시 체크·정리·persist 반영이 일치.  
  - **위험**: 경주마는 “사용자 ON 시 자동 종료 없음”으로, 시간 제한 강제성 및 UI/의도와의 일치가 깨짐.

---

### 4항목 종합

| 구분 | 판정 |
|------|------|
| **확실히 안전** | 완화/초 scalp의 expireAt·endTime 체크 및 만료 시 내부·persist 정리 |
| **위험** | 경주마: userRequestedRaceHorse 로 인한 무기한 유지, UI와 내부 불일치 가능 |

---

## 5. 전체 요약 (3단계)

| 분류 | 항목 |
|------|------|
| **확실히 안전** | • 모드 종료 후 금액 비중·경주마 threshold·aggressive·scalp 전용 파라미터·activePosition 롤백/정리<br>• 같은 market 같은 시점 중복 주문 없음 (priorityOwner 상호 배타)<br>• Emergency Pause로 모든 주문 경로 차단<br>• Legacy vs Signal-Engine 단일 pipeline 승자<br>• 완화/초 scalp의 expireAt·endTime 체크 및 만료 시 내부·persist 정리 |
| **주의 필요** | • 초 scalp 매수 시 orchestrator.recordEntry 미호출 → 스캘프 종료 후 해당 심볼 30분 cooldown 미적용<br>• 초 scalp 경로에 riskGate 미적용 (daily loss, ws_lag, cooldown 등) |
| **위험** | • 완화 모드: getProfile()에 RELAXED_OVERRIDES 미병합 → 진입 기준 완화 미적용<br>• 경주마: 사용자 ON 시 자동 종료 없음(userRequestedRaceHorse), 시간 제한 무력화·UI와 내부 불일치 |

---

## 6. 권장 조치 (재검증 기준)

1. **위험**  
   - **완화**: `StrategyManager.getProfile()` 에 `getRelaxedModeRemainingMs() > 0` 일 때 `RELAXED_OVERRIDES` 병합.  
   - **경주마**: 사용자 ON이라도 최대 유지 시간 또는 “시간대 이탈 후 N분 뒤 자동 OFF” 도입.

2. **주의 필요**  
   - 초 scalp 매수 체결 시 `orchestrator.recordEntry(symbol, 'SCALP')` 호출해 cooldown 공유.  
   - (선택) 초 scalp 진입 전에 riskGate.checkAll 또는 경량 버전 적용.

이 문서는 위 4가지 항목에 대한 엄격 재검증 결과이며, “확실히 안전” / “주의 필요” / “위험” 은 모두 코드 경로 기준으로 판정한 것이다.
