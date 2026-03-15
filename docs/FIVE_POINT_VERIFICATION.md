# 5가지 중점 검증 (코드 인용)

다섯 가지가 **값 단위·흐름 단위**로 맞는지 코드 기준으로 정리함.

---

## 1. 완화 모드가 진짜 getProfile()에 반영되는지

**기대**: 상태값만이 아니라 `entry_score_min`, `strength_threshold` 등 **실제 판단에 쓰이는 값**이 바뀌어야 함.

**코드 근거**

- **StrategyManager.getProfile()** (`lib/StrategyManager.js` 82~92행):
```javascript
function getProfile() {
  const relaxedRemaining = getRelaxedModeRemainingMs();
  let p = { ...baseProfile };
  if (relaxedRemaining > 0) {
    p = { ...p, ...RELAXED_OVERRIDES };  // entry_score_min: 2, strength_threshold: 0.5
  }
  if (raceHorseActive) {
    p = { ...p, ...RACE_HORSE_OVERRIDES };
  }
  return { ...p };
}
```
- **RELAXED_OVERRIDES** (`config.default.js` 63~66행): `{ entry_score_min: 2, strength_threshold: 0.5 }`.

- **실제 사용처** (진입 판단에 사용):
  - `lib/scalpEngine.js` 35~36: `getProfile()` → `StrategyManager.getProfile()` 위임.
  - 51, 97, 122, 192, 280행: `const profile = getProfile()` 후 entry/strength 등 사용.
  - 351행: `profile?.strength_threshold` 사용 (`getEffectiveStrengthThreshold`).
  - `server.js` 1072행: `scalpEngine.getEffectiveEntryScoreMin(profile.entry_score_min, market)` → **진입 최소 점수**에 반영.
  - `server.js` 1053~1054행: `effectiveStrengthThreshold`, `profile.strength_threshold` 사용.

**결론**: 완화 ON 시 `getProfile()`이 `entry_score_min: 2`, `strength_threshold: 0.5`를 포함해 반환하고, 위 경로들이 그대로 진입 판단에 사용하므로 **실제 판단값이 바뀜**.  
상태값만 추가된 것이 아님.

---

## 2. 경주마 자동 만료가 “수동 ON 영구화”를 정말 막는지

**기대**: `userRequestedRaceHorse`가 true여도 **최대 유지 시간 지나면 반드시 OFF** 되어야 함.

**코드 근거**

- **수동 ON 시 만료 시각 설정** (`lib/StrategyManager.js` 118~128행):
```javascript
function setRaceHorseActiveByUser(active) {
  if (active) {
    userRequestedRaceHorse = true;
    raceHorseActive = true;
    raceHorseManualUntil = Date.now() + MAX_MANUAL_RACE_HORSE_MS;  // 2h
    raceHorseExpiryLogged = false;
  } else {
    userRequestedRaceHorse = false;
    raceHorseActive = false;
    raceHorseManualUntil = null;
  }
  refreshProfile();
}
```

- **매 틱 만료 검사 및 강제 OFF** (`lib/StrategyManager.js` 143~161행):
```javascript
if (userRequestedRaceHorse && raceHorseManualUntil != null && now >= raceHorseManualUntil) {
  userRequestedRaceHorse = false;
  raceHorseActive = false;
  raceHorseManualUntil = null;
  refreshProfile();
  if (!raceHorseExpiryLogged) {
    raceHorseExpiryLogged = true;
    console.warn('[StrategyManager] 경주마 모드 자동 만료 (최대 유지 시간 경과)');
  }
  return false;
}
```

- **호출 위치**: `server.js` 1427행 `runOneTick()` 맨 앞에서 `updateRaceHorseState()` → `StrategyManager.updateRaceHorseFromSchedule()` 호출. 즉 **매 틱** 만료 여부를 검사함.

- **토글 경로**: `server.js` 2143행 `toggleRaceHorse`에서 `StrategyManager.setRaceHorseActiveByUser(...)`만 사용하므로, 수동 ON 시에만 `raceHorseManualUntil`이 설정됨.

**결론**: 수동 ON 후 2시간이 지나면 **다음 틱**의 `updateRaceHorseFromSchedule()`에서 `userRequestedRaceHorse`/`raceHorseActive`가 강제로 false로 바뀌고, `raceHorseManualUntil`도 null로 정리됨.  
“수동 ON 영구화”는 막혀 있음.

---

## 3. 초 scalp 경량 riskGate가 “로그만 남기고 통과”가 아닌지

**기대**: `allowed === false`일 때 **진입이 실제로 막혀야** 함 (주문 미실행).

**코드 근거**

- **전역 verdict (daily loss / ws_lag)** (`lib/scalp_independent/scalpRunner.js` 91~98행):
```javascript
const globalVerdict = riskGate.checkScalpLight(gateCtx, '', {});
if (!globalVerdict.allowed) {
  try {
    logLine('[SCALP_RISK] ' + JSON.stringify({ type: 'scalp_risk_gate', scope: 'global', reasons: globalVerdict.reasons, ts: Date.now() }));
  } catch (_) {}
  return;   // 여기서 함수 종료 → getTickers/getOrderbook/진입 루프 자체 미실행
}
```
→ `return`으로 **진입 로직 전체를 건너뜀**. 주문 경로에 도달하지 않음.

- **심볼별 verdict (cooldown 등)** (같은 파일 140~146행):
```javascript
const scalpLightVerdict = riskGate.checkScalpLight(gateCtx, symbol, {});
if (!scalpLightVerdict.allowed) {
  try {
    logLine('[SCALP_RISK] ' + JSON.stringify({ ... }));
  } catch (_) {}
  continue;   // 이 마켓만 스킵, 아래 placeMarketBuyByPrice 미실행
}
```
→ `continue`로 **해당 마켓의 진입만 스킵**. `TradeExecutor.placeMarketBuyByPrice` 호출부(172행 근처)는 이 분기에서 **실행되지 않음**.

**결론**: `allowed === false`이면  
- 전역: `return`으로 틱 전체 진입 차단,  
- 심볼별: `continue`로 해당 심볼만 진입 차단.  
둘 다 **실제 주문은 나가지 않음**. “로그만 남기고 통과”하는 경로는 없음.

---

## 4. 모드 종료 후 원복이 값 단위로 되는지

**기대**: flag만 OFF가 아니라 **금액 비중, threshold, aggressive 파라미터**가 **다음 틱부터** 원래대로 돌아가야 함.

**코드 근거**

- **경주마 OFF 후**
  - `state.raceHorseActive`: 매 틱 `updateRaceHorseState()` → `StrategyManager.isRaceHorseActive()`로 갱신 (`server.js` 912~913행). 자동 만료 시 `raceHorseActive = false`이므로 다음 틱부터 false.
  - **금액 비중**: `server.js` 1517행 `use50PercentOrder = state.raceHorseActive && isRaceHorseTimeWindow` → 다음 틱부터 false → 50% 로직 미적용.
  - **주문 금액**: 1510~1514행 `getBuyOrderAmountKrw(..., isRaceHorseMode: state.raceHorseActive, ...)` → 다음 틱부터 일반 금액 로직.
  - **프로필**: `getProfile()`이 `raceHorseActive`일 때만 `RACE_HORSE_OVERRIDES` 병합하므로, OFF 후에는 가중치 등이 base(또는 base+relaxed)만 남음.

- **완화 만료 후**
  - `getRelaxedModeRemainingMs()`가 만료 시 내부에서 `relaxedUntil = 0`으로 정리 (`lib/StrategyManager.js` 107~113행).
  - `getProfile()`은 매번 `getRelaxedModeRemainingMs() > 0`으로 판단하므로, 만료된 다음 호출부터는 RELAXED_OVERRIDES를 붙이지 않음 → `entry_score_min`, `strength_threshold` 등이 base 값으로 복귀.

- **aggressive (AI 가중치)**
  - `scalpEngine.getAggressiveSymbols()`는 `data.until > now`인 것만 반환하고, 만료된 항목은 삭제 (`lib/scalpEngine.js` 314~322행). 따라서 시간 경과 후에는 해당 심볼이 목록에서 빠져 multiplier/threshold가 기본으로 돌아감.

**결론**:  
- 경주마: `state.raceHorseActive`와 `getProfile()`이 매 틱 갱신되므로, OFF 다음 틱부터 금액 비중·가중치·threshold가 기본값으로 동작.  
- 완화: 만료 시점 이후 `getProfile()` 호출부터 완화 오버라이드가 사라져 값 단위 원복.  
- aggressive: 만료 시 목록에서 제거되므로 값 단위 원복.  
→ “flag만 OFF”가 아니라 **실제 사용되는 값들이 다음 틱/다음 호출부터 원복**되도록 되어 있음.

---

## 5. 중복 주문 방지 구조를 건드리지 않았는지

**기대**: 새 riskGate·mode 로직을 넣으면서 **priorityOwner 흐름**이 깨지지 않았는지 확인.

**코드 근거**

- **메인 쪽 진입 차단** (`server.js` 1497~1501행):
```javascript
if (state.botEnabled && orchResult.action === 'ENTER' && orchResult.signal && ...) {
  if (scalpState.priorityOwner === 'SCALP') {
    // 독립 스캘프 봇 가동 중: 메인 오케스트레이터 진입 차단 (우선권 탈취)
  } else {
    // ... 주문 실행
  }
}
```
→ `priorityOwner === 'SCALP'`이면 메인 주문 블록 전체를 실행하지 않음. **변경 없음.**

- **초 scalp 실행 조건** (`server.js` 1629~1631행):
```javascript
if (state.scalpMode && scalpState.isRunning) {
  try {
    await scalpRunner.tick({ ... });
```
→ `scalpState.isRunning`은 `activate()` 시 true, `stop()` 시 false. `activate()`에서 `priorityOwner = 'SCALP'` 설정하므로, **스캘프가 돌아가는 동안에는 항상 priorityOwner === 'SCALP'**이고, 메인은 위에서 진입을 스킵함. **변경 없음.**

- **추가된 부분**:
  - `scalpRunner.tick()` **진입 후**에만 riskGate 체크 추가 (전역 return, 심볼별 continue).  
  - `scalpRunner.tick()`이 호출되는 조건은 여전히 `state.scalpMode && scalpState.isRunning` 하나뿐.  
  - `priorityOwner`를 읽거나 쓰는 코드는 수정하지 않음.  
  - 메인 ENTER 블록의 `if (scalpState.priorityOwner === 'SCALP')` 분기도 그대로 유지.

**결론**:  
- “SCALP일 때 메인 진입 스킵” / “메인일 때만 scalpRunner 호출” 구조는 그대로임.  
- riskGate는 스캘프 **내부**에서만 “진입 여부”를 제한할 뿐, **누가 주문할 수 있는지(priorityOwner)** 를 바꾸지 않음.  
→ **중복 주문 방지(priorityOwner 흐름)는 건드리지 않은 상태로 유지됨.**

---

## 요약 표

| 항목 | 검증 결과 | 근거 |
|------|-----------|------|
| 1. 완화 모드 getProfile() 반영 | ✅ 반영됨 | getProfile()이 RELAXED_OVERRIDES 병합 → scalpEngine/서버가 entry_score_min, strength_threshold 사용 |
| 2. 경주마 수동 ON 영구화 방지 | ✅ 막힘 | setRaceHorseActiveByUser로 만료 시각 설정, 매 틱 updateRaceHorseFromSchedule에서 만료 시 강제 OFF |
| 3. 초 scalp riskGate 실제 차단 | ✅ 차단됨 | 전역은 return, 심볼별는 continue → placeMarketBuyByPrice 미실행 |
| 4. 모드 종료 후 값 단위 원복 | ✅ 원복됨 | raceHorseActive/relaxedRemaining/getProfile()/getAggressiveSymbols()가 매 틱/호출 기준으로 갱신·반영 |
| 5. 중복 주문(priorityOwner) 유지 | ✅ 유지됨 | priorityOwner/메인 ENTER 스킵/스캘프 호출 조건 코드 미변경, riskGate는 스캘프 내부 진입만 제한 |

위 다섯 가지는 모두 현재 코드 기준으로 만족하는 상태로 보면 됨.
