# 모드·안전장치·상태 전이 감사 (코드 기준)

## 1. 전체 구조 요약

- **기본 매매 엔진**: `server.js`의 `runOneTick` → `runScalpCycle`(시그널 생성) → `runExitPipeline`(청산) → `orchestrator.tick`(진입 결정) → 주문 실행. 단일 `state`/`EngineStateStore`, 동일 Upbit 계정·주문 엔진(`TradeExecutor`, `withUpbitFailover`) 사용.
- **경주마 모드**: 별도 봇이 아님. `StrategyManager`의 `raceHorseActive`/`userRequestedRaceHorse`와 `profile`에 `RACE_HORSE_OVERRIDES` 병합. `updateRaceHorseState()`로 매 틱 동기화. 시간대는 `isRaceHorseWindow()`(08:55~09:10 KST), 실주문 50%는 `isRaceHorseTimeWindow()`(09:00~10:00)에서만 적용.
- **완화 모드**: 별도 봇 아님. `StrategyManager`의 `relaxedUntil`(만료 시각 ms). `setRelaxedMode(ttlMs)`로 4시간 적용, `getRelaxedModeRemainingMs()`로 남은 시간. **확인 결과: `getProfile()`은 `RELAXED_OVERRIDES`를 전혀 병합하지 않음. 완화 모드가 켜져 있어도 진입 기준(entry_score_min, strength_threshold)이 바뀌지 않음.**
- **초 scalp 모드**: `lib/scalp_independent/scalpState.js` 싱글톤 + `scalpRunner.tick()`. `activate()` 시 3시간 시한·`priorityOwner='SCALP'`, `checkExpiry()`로 만료 시 `stop()`. 메인과 **동일 state/계정**을 쓰며, `scalpState.priorityOwner === 'SCALP'`일 때만 메인 오케스트레이터 진입을 차단하고 스캘프가 진입·청산 담당.

---

## 2. 모드별 매핑표

| 모드명 | 관련 파일 | 관련 상태값 | 시작 조건 | 종료 조건 | 연장 방식 | 우선순위 | 위험 요소 |
|--------|-----------|-------------|-----------|-----------|-----------|----------|-----------|
| 기본 매매 엔진 | server.js, orchestrator.js, scalpEngine.js, StrategyManager.js | state.botEnabled, EngineStateStore, profile (baseProfile) | botEnabled, 스케줄 상시 | - | - | 신호·실행의 기본 | - |
| 경주마 모드 | StrategyManager.js, config.default.js (RACE_HORSE_OVERRIDES), server.js updateRaceHorseState | raceHorseActive, userRequestedRaceHorse, baseProfile.race_horse_scheduler_enabled | (1) 스케줄 ON + isRaceHorseWindow() (2) 디스코드 toggleRaceHorse | (1) 시간대 이탈 시: `!userRequestedRaceHorse`일 때만 setRaceHorseActive(false) (2) 사용자 OFF | 사용자 버튼으로 ON 유지 시 **시간대 밖에서도 OFF로 덮어쓰지 않음** → 무기한 유지 가능 | 프로필 오버레이(금액 50%·가중치) | **High: 사용자 한 번 ON 시 자동 종료 없이 영구 유지 가능** |
| 완화 모드 | StrategyManager.js, config.default.js (RELAXED_OVERRIDES), server.js, discordBot.js | relaxedUntil (ms) | Discord `relax_toggle` → setRelaxedMode(4*60*60*1000) | getRelaxedModeRemainingMs() ≤ 0 시 relaxedUntil=0 자동 정리 | Discord `relax_extend` (수동 연장) | **실제 진입 로직에 미반영** | **High: RELAXED_OVERRIDES가 getProfile()에 병합되지 않아 완화 모드가 동작하지 않음** |
| 초 scalp 모드 | scalpState.js, scalpRunner.js, server.js (startIndependentScalp 등) | isRunning, endTime, priorityOwner, activePosition, riskHaltUntil | Discord `start_scalp` → scalpState.activate(), 기준 완화 중이면 setRelaxedMode(0)으로 완화 종료 | checkExpiry() → endTime 초과 시 stop() | extend(): 남은 시간 < 1시간일 때만 +3시간 (수동 연장) | priorityOwner='SCALP' 시 메인 ENTER 차단 | **Medium: 만료 시 activePosition 미정리 → runExitPipeline이 해당 마켓 스킵 → 청산 주체 없음** |

---

## 3. 실제 호출 흐름

```
TradingEngine.mainPoll (domain/trading/TradingEngine.js)
  → ApiAccessPolicy.refreshEngineMode(stateStore)
  → mode === EMERGENCY_PAUSE 이면 runOneTick 호출 안 함, emitDashboard만
  → runOneTick()
       → updateRaceHorseState()                    // 경주마 스케줄 반영
       → fetchAssets() (RECOVERY면 10초 간격)
       → runScalpCycle()                           // P0/시그널만 생성, 주문 없음
       → runExitPipeline()                         // ExitPolicy.evaluate, canPlaceOrder 후 매도
       → orchestrator.tick(orchCtx)                // riskGate.checkAll(daily loss, ws_lag, cooldown 등) 여기서 적용
       → if (botEnabled && action==='ENTER' && signal && !(scalpState.priorityOwner==='SCALP'))
            → canPlaceOrder(state) 후 주문 (TradeExecutor / ExecutionEngine)
       → if (state.scalpMode && scalpState.isRunning)
            → scalpRunner.tick(ctx)                // checkExpiry, isRiskHalt, 진입/청산 (riskGate 미적용)
```

- **안전장치 순서**:  
  1) **refreshEngineMode** (PAUSE면 runOneTick 자체 미실행)  
  2) **canPlaceOrder** (각 주문 직전: runExitPipeline 매도, 오케스트레이터 매수, 수동 매수/매도, sellAll)  
  3) **withUpbitFailover** 내부에서 PAUSE면 fn 미호출·undefined 반환  
  4) **orchestrator.tick** 내부에서 **riskGate.checkAll** (daily_loss_limit, ws_lag, max_open_positions, cooldown 등)  
  5) USE_SIGNAL_ENGINE 시 **riskEngineFromBootstrap.evaluate** 후 실행  

- **확인**: 429/emergency pause는 runOneTick 진입 전과 주문 전에 적용됨. riskGate는 **메인 오케스트레이터 진입 경로에만** 있음. **초 scalp(scalpRunner.tick)에는 riskGate 없음** (isRiskHalt, checkExpiry만 있음).

---

## 4. 우선순위 판정

- **긍정**:  
  - Emergency pause / canPlaceOrder가 runOneTick 및 각 주문 앞단에 있음.  
  - 초 scalp 가동 시 메인 ENTER가 `priorityOwner === 'SCALP'`로 차단되어, 동일 계정에서 동시 진입은 막혀 있음.  
  - runExitPipeline은 독립 스캘프가 보유한 마켓을 스킵해, 같은 포지션에 대한 이중 청산은 방지됨.

- **문제 가능 상황**:  
  1) **경주마**: 사용자가 경주마 ON 후 시간대가 지나도 `userRequestedRaceHorse` 때문에 자동 OFF가 되지 않아, 50% 비중·공격적 가중치가 무기한 유지될 수 있음.  
  2) **완화 모드**: `getProfile()`이 `RELAXED_OVERRIDES`를 쓰지 않아, 완화 모드가 켜져 있어도 entry_score_min/strength_threshold가 그대로라 “기준 완화”가 실질적으로 미동작함.  
  3) **초 scalp 만료**: `stop()` 시 `activePosition`을 비우지 않음. 만료 후에는 `scalpRunner.tick`이 실행되지 않아 청산이 안 되는데, runExitPipeline은 여전히 `posByScalp?.market === market`이면 스킵하므로, 해당 마켓 포지션이 자동 청산되지 않음.  
  4) **초 scalp 경로**: riskGate(daily loss, ws_lag, cooldown 등)가 적용되지 않아, 메인보다 완화된 조건으로 진입할 수 있음.

---

## 5. 반드시 수정해야 할 문제

| 심각도 | 내용 | 이유 |
|--------|------|------|
| **High** | 경주마 모드가 사용자 ON 후 무기한 유지 가능 | `updateRaceHorseFromSchedule()`이 `!userRequestedRaceHorse`일 때만 OFF. 사용자 한 번 ON 시 시간대 밖에서도 자동 종료되지 않음. |
| **High** | 완화 모드가 진입 로직에 반영되지 않음 | `StrategyManager.getProfile()`은 `baseProfile + (raceHorseActive ? RACE_HORSE_OVERRIDES : {})`만 반환. `getRelaxedModeRemainingMs() > 0`일 때 `RELAXED_OVERRIDES` 병합이 없음. |
| **High** | 초 scalp 만료 시 보유 포지션 청산 주체 없음 | `stop()`이 `activePosition`을 null로 만들지 않음. runExitPipeline은 `posByScalp?.market === market`이면 스킵하므로, scalp 종료 후 해당 마켓은 메인이 청산하지 않음. |
| **Medium** | 초 scalp 진입에 riskGate 미적용 | orchestrator만 riskGate.checkAll 사용. scalpRunner.tick은 daily loss, ws_lag, cooldown 등 공통 안전장치를 거치지 않음. |
| **Medium** | runExitPipeline 스킵 조건이 “스캘프 가동 여부”와 무관 | `scalpMarket === market`만 보고 스킵해서, 스캘프가 이미 종료된 경우에도 해당 마켓을 스킵함. 스캘프가 실제로 담당 중일 때만 스킵해야 함. |
| **Low** | 경주마와 완화 모드 동시 적용 시 명시 규칙 없음 | 경주마가 켜지면 profile에 RACE_HORSE_OVERRIDES만 적용. 완화는 현재 로직상 반영되지 않아, 나중에 완화를 붙이면 “경주마+완화” 우선순위/병합 규칙이 필요함. |

---

## 6. 추천 수정안 (최소 침습)

1. **경주마 시간 제한 (자동 영구 유지 방지)**  
   - `StrategyManager`: `userRequestedRaceHorse`로 “사용자 요청 ON”을 유지하되, **최대 유지 시간** 도입 (예: 2시간).  
   - 예: `raceHorseUserActivatedAt` 저장, `updateRaceHorseFromSchedule()`에서 “시간대 밖 && userRequestedRaceHorse && (now - raceHorseUserActivatedAt) > MAX_USER_RACE_HORSE_MS”이면 setRaceHorseActive(false) 및 userRequestedRaceHorse=false.  
   - 또는 “시간대 밖이면 무조건 N분 후 자동 OFF”처럼, 사용자 ON이라도 **자동 만료** 한 번 두는 방식.

2. **완화 모드가 진입에 반영되도록**  
   - `StrategyManager.getProfile()`에서 `getRelaxedModeRemainingMs() > 0`이면 `RELAXED_OVERRIDES`를 병합 (예: `profile = { ...profile, ...RELAXED_OVERRIDES }`).  
   - 만료 시 이미 `relaxedUntil = 0`으로 정리되므로, 만료 후에는 자동으로 기본 프로필로 복귀.

3. **초 scalp 만료 시 포지션·스킵 정리**  
   - `scalpState.stop()`에서 `this.activePosition = null` 추가.  
   - 그리고 runExitPipeline 스킵 조건을 **“스캘프가 실제로 담당 중일 때만”** 으로 변경:  
     `if (scalpState.isRunning && posByScalp && scalpMarket === market) continue;`  
   - 그러면 스캘프 종료 후에는 메인이 해당 마켓도 청산 담당.

4. **초 scalp에 riskGate 적용 (선택)**  
   - scalpRunner.tick 진입 전 또는 진입 결정 직전에, orchestrator와 동일한 riskGate.checkAll(또는 경량 버전)을 한 번 호출해, daily loss / ws_lag / cooldown 등이 초 scalp에도 적용되도록 함.

5. **상태·대시보드 반영**  
   - 모드 만료 시(경주마 자동 OFF, 완화 만료, 초 scalp checkExpiry) EngineStateStore 또는 state 한 번 갱신하고, 필요 시 emitDashboard/디스코드 상태 메시지로 “모드 종료됨”이 보이도록 하면, 운영 시 혼동을 줄일 수 있음.

---

## 7. 추가 확인 사항 (요청 질문에 대한 코드 기준 답)

**1) 모드 체계 구성**  
- 기본 엔진: `server.js` runOneTick → runScalpCycle, orchestrator.tick, 주문. `state.botEnabled`, `scalpEngine.getProfile()`.  
- 경주마: `StrategyManager` (raceHorseActive, userRequestedRaceHorse), `updateRaceHorseState()` (server.js), `getBuyOrderAmountKrw(..., isRaceHorseMode, isRaceHorseTimeWindow)`.  
- 완화: `StrategyManager` (relaxedUntil, setRelaxedMode, getRelaxedModeRemainingMs). 진입 로직에는 **미반영**.  
- 초 scalp: `scalpState.js` (isRunning, endTime, priorityOwner, activePosition), `scalpRunner.tick()`, server.js `startIndependentScalp`/`stopIndependentScalp`/`extendIndependentScalp`.

**2) 동시 활성화**  
- 경주마 + 완화: 동시에 켜질 수 있음. 현재는 완화가 프로필에 안 붙어 있어 실질 충돌 없음.  
- 경주마 + 초 scalp: 동시 가능. 초 scalp가 켜지면 메인 ENTER가 차단되므로 **진입은 스캘프만**. 경주마는 메인 쪽 금액/가중치만 쓰이므로, 스캘프가 진입할 때는 경주마 50% 로직이 적용되지 않음 (스캘프는 자체 amountKrw 계산).  
- 완화 + 초 scalp: 시작 시 완화를 0으로 끄므로(scalp 시작 시 setRelaxedMode(0)) 동시 유지되지 않음.

**3) 최종 의사결정 우선순위 (호출 순서)**  
1. refreshEngineMode / EMERGENCY_PAUSE (runOneTick 진입 차단)  
2. canPlaceOrder (각 주문 직전)  
3. withUpbitFailover (PAUSE면 API 스킵)  
4. orchestrator.tick 내부 riskGate.checkAll (메인 진입만)  
5. (USE_SIGNAL_ENGINE 시) riskEngineFromBootstrap.evaluate  
6. mode 반영 (경주마 → getBuyOrderAmountKrw, profile 오버레이 등)  
7. signal evaluation (runScalpCycle, orchestrator compare)  
8. execution (TradeExecutor / ExecutionEngine)

**4) “시간 제한 후 자동 종료 + 수동 연장만”**  
- **완화**: 구현됨. `relaxedUntil` 만료 시 getRelaxedModeRemainingMs에서 relaxedUntil=0으로 정리. 연장은 Discord `relax_extend`.  
- **초 scalp**: 구현됨. checkExpiry()로 endTime 초과 시 stop(). extend()는 남은 시간 < 1시간일 때만 +3시간.  
- **경주마**: **미구현**. 사용자 ON 시 자동 종료가 없어 무기한 유지 가능.

**5) 모드 종료 후 기본 복귀**  
- 경주마 OFF 시: `profile = baseProfile`만 남음 (RACE_HORSE_OVERRIDES 제거). 롤백됨.  
- 완화 만료 시: relaxedUntil=0만 바뀌고, **현재는 프로필에 완화가 반영되지 않아** 롤백할 “완화 적용값”이 없음.  
- 초 scalp stop(): priorityOwner=MAIN, isRunning=false. activePosition 미정리로 인해 위 5번 이슈 발생.

**6) 초 scalp와 기본 엔진 충돌**  
- 같은 시장 중복 주문: `priorityOwner === 'SCALP'`일 때 메인 ENTER 차단으로 방지됨.  
- 같은 포지션 이중 관리: runExitPipeline이 스캘프 보유 마켓 스킵으로, 청산은 한 쪽만 담당.  
- **만료 후**: activePosition 미정리 + 스킵 조건이 “스캘프 가동 여부”를 보지 않아, 만료 후 해당 마켓 청산이 빠짐.

**7) 경주마 vs 완화**  
- 경주마: RACE_HORSE_OVERRIDES (가중치·김프 등) + 09:00~10:00 시간대에 **금액 50%** (getBuyOrderAmountKrw).  
- 완화: RELAXED_OVERRIDES (entry_score_min: 2, strength_threshold: 0.5)로 **진입 기준 완화** 설계이나, getProfile()에 미병합으로 **현재 미적용**.  
- 둘 다 켜져 있으면: profile에는 경주마만 반영되고, 완화는 UI/남은 시간만 있고 진입 로직에는 없음.

**8) 안전장치 우선 적용**  
- 429/emergency: mainPoll에서 runOneTick 전, 그리고 withUpbitFailover에서 적용. **모드·진입·실행보다 앞섬.**  
- canPlaceOrder: 모든 주문 직전. **실행 직전.**  
- riskGate(daily loss, ws_lag 등): orchestrator.tick **내부**에서, 신호 선택 이후·주문 전. 메인 경로만 해당.  
- **초 scalp 경로에는** 429/withUpbitFailover/canPlaceOrder는 적용되나, **riskGate는 적용되지 않음.**

위 내용을 기준으로 수정 적용 시, “안전장치 최우선·기본 엔진 중심·시간제 모드 자동 종료 및 수동 연장·모드 종료 후 롤백” 요구사항을 만족시키는 방향으로 정리한 것이다.
