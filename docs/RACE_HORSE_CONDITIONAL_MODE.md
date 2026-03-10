# 경주마 모드 — 조건 기반 공격 모드 설계

## 1. 현재 경주마 모드 구현 감사

### 관련 파일
- `dashboard/lib/StrategyManager.js` — 경주마 활성/시간대/프로필 병합
- `dashboard/config.default.js` — `RACE_HORSE_OVERRIDES`
- `dashboard/lib/scalpEngine.js` — `getBuyOrderAmountKrw`, `getProfile()`
- `dashboard/server.js` — `updateRaceHorseState()`, ENTER 블록, `use50PercentOrder`, cashLock
- `dashboard/lib/strategy/orchestrator.js` — `tick()`, riskGate, 시그널 선택

### 관련 함수
- `StrategyManager.updateRaceHorseFromSchedule()` — 스케줄(08:55~09:10 KST) 또는 사용자 ON 시 활성화, 만료 시 OFF
- `StrategyManager.isRaceHorseTimeWindow()` — 09:00~10:00 KST 여부 (50% 적용 시간대)
- `StrategyManager.isRaceHorseActive()` / `state.raceHorseActive`
- `StrategyManager.getProfile()` — `raceHorseActive` 시 `RACE_HORSE_OVERRIDES` 병합
- `scalpEngine.getBuyOrderAmountKrw(opts)` — `isRaceHorseMode && isRaceHorseTimeWindow` 이면 (orderableKrw + totalCoinEval) * 0.5
- `server.js` ENTER 블록: `use50PercentOrder = state.raceHorseActive && isRaceHorseTimeWindow` → 50% 시 amountKrw 그대로 사용

### 현재 동작 방식
1. **활성화**: 스케줄 ON + 08:55~09:10 KST 또는 사용자 버튼 ON(최대 2시간 유지).
2. **프로필**: 경주마 활성 시 `RACE_HORSE_OVERRIDES`(weight_vol_surge, weight_strength, weight_price_break, kimp_block_pct) 병합.
3. **금액**: 09:00~10:00이고 경주마 활성이면 **무조건** (보유 KRW + 코인 평가액)의 50%로 매수 금액 계산. 신호 품질/거래량/strength/돌파/orchestrator score/risk gate 통과 여부와 무관하게 50% 적용.
4. **진입**: orchestrator.tick() → riskGate.checkAll 통과 후 ENTER 시, cashLock 비활성일 때만 매수. **경주마일 때 허용 코인(BTC/ETH/SOL/XRP) 제한 없음.**
5. **청산**: 기존과 동일. 매도/청산은 항상 허용.

---

## 2. 설계 요약 — 조건부 공격 모드

- **시간대(09:00~10:00)** 는 “공격 허용 구간”일 뿐이며, **실제 50% 투입은 신호 품질이 충분할 때만** 허용.
- **조건부 티어**
  - **FULL_50**: 거래량 급증 + strength + 돌파(price_break) + orchestrator score 높음(≥0.75) + P0(스프레드 등) 정상 → 50% 허용.
  - **MEDIUM_25**: 조건 일부 충족 + orchestrator score 중간(≥0.65) → 25% 허용.
  - **NORMAL**: 그 외 진입 가능한 경우 → 기본 사이즈(min_order_krw 등).
  - **BLOCKED**: 50%/25% 미허용 → 기본 사이즈만 사용.
- **허용 코인**: 경주마 모드에서 진입/회전은 **BTC, ETH, SOL, XRP** 만 허용. 그 외 코인(DOGE, ADA 등)으로의 진입은 거절.
- **cashLock**: `orderableKrw < GLOBAL_MIN_BUYABLE_KRW` 이면 신규 매수 전부 금지(기존과 동일). 매도/청산은 항상 허용.
- **riskGate / restart pause / cooldown / emergency pause**: 기존 정책 유지. 경주마는 사이징·허용 코인만 추가 제한.

---

## 3. Rotation 설계 (BTC/ETH/SOL/XRP 내부)

- **회전 허용 범위**: BTC, ETH, SOL, XRP 내부에서만 포지션 교체/추가 허용.
- **구현**: orchestrator가 이미 1개 시그널(SCALP 또는 REGIME)을 선택. 해당 `signal.symbol`이 `RACE_HORSE_ALLOWED_SYMBOLS`에 없으면 **ENTER 자체를 하지 않음** (거절 로그: "경주마: 허용 코인 아님 (BTC/ETH/SOL/XRP만)").
- **ETH → BTC** 같은 회전: 두 코인 모두 허용 목록에 있으므로, orchestrator가 BTC를 선택하면 진입 가능. 기존 ETH 포지션은 별도 청산 로직(기존 runExitPipeline/tickExit)으로 처리.
- **ETH → DOGE** 금지: DOGE는 허용 목록에 없으므로, 경주마 시간대에 DOGE 신호가 나와도 ENTER 거절.
- **명확한 우위/회전 횟수/동일 코인 재진입 cooldown**: 현재는 orchestrator의 기존 riskGate·cooldown·진입 제한을 그대로 사용. 추가로 “경주마 전용 회전 횟수/재진입 쿨다운”이 필요하면 `raceHorsePolicy.getRaceHorseContext()` 및 확장으로 도입 가능.

---

## 4. 실제 코드 패치 요약

### 4.1 신규 파일: `lib/strategy/raceHorsePolicy.js`
- `RACE_HORSE_ALLOWED_SYMBOLS = ['BTC','ETH','SOL','XRP']`
- `isSymbolAllowedForRaceHorse(symbol)`
- `isRaceHorseHighConviction(signal, finalScore, scalpStateEntry)` → `'FULL_50'|'MEDIUM_25'|'NORMAL'|'BLOCKED'`
- `getRaceHorseContext(positionSymbols, scalpState, profile)` — 허용 코인/보유 허용/후보 심볼

### 4.2 `lib/scalpEngine.js` — getBuyOrderAmountKrw
- 인자에 `raceHorseTier` 추가.
- `use50Percent` = 경주마 시간대 **및** `raceHorseTier === 'FULL_50'` 일 때만 50%.
- `use25Percent` = 경주마 시간대 **및** `raceHorseTier === 'MEDIUM_25'` 일 때 25%.
- 그 외(NORMAL/BLOCKED/미설정)는 기존과 동일하게 기본 금액 로직.

### 4.3 `server.js` — ENTER 블록
- `require('./lib/strategy/raceHorsePolicy')` 추가.
- **cashLock**: 기존과 동일. `state.cashLock?.active` 이면 신규 매수 중단, 로그만 출력.
- **경주마 + 시간대**일 때:
  - `raceHorsePolicy.isSymbolAllowedForRaceHorse(symbol)` false면 ENTER 거절 (로그: "경주마: 허용 코인 아님 (BTC/ETH/SOL/XRP만)").
  - `scalpStateEntry = state.scalpState[market]`, `raceHorseTier = isRaceHorseHighConviction(signal, finalScore, scalpStateEntry)`.
  - `getBuyOrderAmountKrw(..., raceHorseTier)` 호출.
  - `useRaceHorseSizing = (tier === 'FULL_50' || tier === 'MEDIUM_25')` 로 50%/25% 금액을 그대로 사용할지 결정.

---

## 5. 검증 포인트

| 항목 | 기대 동작 |
|------|-----------|
| 9시라도 신호 약하면 50% 금지 | `isRaceHorseHighConviction`이 FULL_50을 반환하지 않으면 50% 미적용. NORMAL/BLOCKED 시 기본 사이즈만 사용. |
| 신호 강하면 FULL_50 허용 | vol_surge + strength_ok + price_break + finalScore ≥ 0.75 + P0 정상 시 FULL_50 → 50% 적용. |
| ETH → BTC rotation 가능 | BTC, ETH 모두 허용 목록에 있으므로 orchestrator가 BTC 선택 시 진입 허용. |
| ETH → DOGE rotation 금지 | DOGE는 허용 목록에 없음. 경주마 시간대에 DOGE 신호 시 ENTER 거절. |
| cash lock 시 매수 금지 | `state.cashLock?.active` 이면 ENTER 블록 진입 후 즉시 거절 로그 후 매수 수행 안 함. |
| 청산 항상 허용 | runExitPipeline / scalpRunner.tickExit 는 cashLock과 무관하게 기존대로 실행. |

---

## 6. 주의 사항

- **추측 금지**: 위 동작은 모두 실제 코드(StrategyManager, scalpEngine, server.js, orchestrator, riskGate) 기준으로 정리·수정함.
- **기존 정책 유지**: riskGate, cashLock, restart/pause, cooldown, emergency pause 등은 변경하지 않음.
- **최소 침습**: 경주마 “조건부 50%/25%”와 “허용 코인 4개”만 추가하고, 나머지 플로우는 유지.
