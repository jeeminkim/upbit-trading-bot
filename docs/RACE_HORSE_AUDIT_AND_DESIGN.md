# 경주마 모드 감사 및 실전형 설계

## 1) 현재 RaceHorse 모드 구현 감사 결과

### 관련 파일

| 파일 | 역할 |
|------|------|
| `dashboard/lib/StrategyManager.js` | 경주마 활성/시간대, 프로필 병합, 스케줄·수동 ON |
| `dashboard/config.default.js` | `RACE_HORSE_OVERRIDES`, `DEFAULT_PROFILE` |
| `dashboard/lib/scalpEngine.js` | `getBuyOrderAmountKrw`, `getProfile()` 위임 |
| `dashboard/server.js` | `updateRaceHorseState`, ENTER 블록, cashLock, 회전 판단 |
| `dashboard/lib/strategy/raceHorsePolicy.js` | 티어·자본비율·asset score·회전 판단 |
| `dashboard/lib/strategy/orchestrator.js` | `tick()`, 시그널 선택, riskGate |
| `dashboard/lib/risk/riskGate.js` | `checkAll`, min_orchestrator_score, cooldown 등 |

### 관련 함수

| 함수 | 위치 | 역할 |
|------|------|------|
| `updateRaceHorseFromSchedule` | StrategyManager | 스케줄(08:55~09:10) 또는 수동 ON 시 활성, 만료 시 OFF |
| `isRaceHorseTimeWindow` | StrategyManager | 09:00~10:00 KST 여부 (사이징·표시용) |
| `isRaceHorseActive` | StrategyManager | 현재 경주마 활성 여부 |
| `getProfile` | StrategyManager | base + relaxed + raceHorse 오버레이 |
| `getBuyOrderAmountKrw` | scalpEngine | 조건부 티어(FULL_50/MEDIUM_25/LIGHT_10/NORMAL/BLOCKED) → 금액 |
| `updateRaceHorseState` | server | 매 틱 StrategyManager 동기화 + 창 종료 시 회전 카운트 리셋 |
| `updateCashLock` | server | orderableKrw < GLOBAL_MIN_BUYABLE_KRW 시 신규 매수 잠금 |
| `orchestrator.tick` | orchestrator | SCALP/REGIME 비교, riskGate, ENTER/SKIP 결정 |

### 관련 상태값

| 상태 | 위치 | 의미 |
|------|------|------|
| `raceHorseActive` | StrategyManager (내부) | 경주마 ON/OFF |
| `userRequestedRaceHorse` | StrategyManager (내부) | 사용자 버튼 ON 유지 |
| `raceHorseManualUntil` | StrategyManager (내부) | 수동 ON 만료 시각(ms) |
| `state.raceHorseActive` | server state | 매 틱 StrategyManager와 동기화 |
| `state.cashLock.active` | server state | 현금 부족 시 true, 신규 매수 전부 중단 |
| `sessionRotationCount` | raceHorsePolicy (모듈) | 세션 내 회전 횟수 (MAX_ROTATIONS_PER_SESSION 제한) |

### 현재 동작 방식

- **활성화**: `race_horse_scheduler_enabled` + 08:55~09:10 KST → 자동 ON. 또는 사용자 토글 → 수동 ON(최대 2시간).
- **프로필**: 경주마 ON 시 `RACE_HORSE_OVERRIDES`(weight_vol_surge, weight_strength, weight_price_break, kimp_block_pct) 병합.
- **사이징**: 09:00~10:00 + 경주마 ON일 때 **신호 품질**에 따라 티어 결정 → FULL_50(50%) / MEDIUM_25(25%) / LIGHT_10(10%) / NORMAL(기본) / BLOCKED(매수 금지). 무조건 50% 없음.
- **진입**: cashLock 비활성, 허용 코인(BTC/ETH/SOL/XRP), 회전 우위(보유 대비 후보 우위·비용 반영) 충족 시에만 ENTER. BLOCKED면 매수 스킵.
- **청산**: runExitPipeline / tickExit 는 cashLock·경주마와 무관하게 항상 허용.

### 현재 구현이 단순 시간 기반이 아닌 이유

- **시간**은 “공격 허용 구간(09:00~10:00)”만 제공.
- **실제 금액**은 `evaluateRaceHorseConviction` → 티어 → `getBuyOrderAmountKrw(raceHorseTier)`로 **신호 품질(vol_surge, strength, price_break, orchestrator score, expected edge, P0)** 에 따라 50%/25%/10%/기본/0으로 가변.
- **회전**은 4코인 내부에서만, `shouldRotateHolding`으로 우위·비용·MIN_HOLD·세션 회전 수 제한 적용.

---

## 2) 설계 요약

### RaceHorse를 “조건 기반 공격 모드”로 적용

- **시간대**: 09:00~10:00은 “공격적 사이징 허용 구간”일 뿐.
- **티어**: `evaluateRaceHorseConviction(signal, finalScore, scalpStateEntry)`로 FULL_50 / MEDIUM_25 / LIGHT_10 / NORMAL / BLOCKED 결정.
- **자본 비율**: `getRaceHorseCapitalFraction(tier)` → 0.5 / 0.25 / 0.1 / null / 0. BLOCKED면 매수 금지.

### Sizing tier 설계

| 티어 | 조건 요약 | 자본 비율 |
|------|-----------|-----------|
| FULL_50 | vol_surge+strength+breakout 3개, orch≥0.78, P0 정상, expected edge 충족 | 50% |
| MEDIUM_25 | strongCount≥2, orch≥0.70, edge 충족 | 25% |
| LIGHT_10 | strongCount≥1 또는 orch≥0.65, orch≥0.62 | 10% |
| NORMAL | orch≥0.62 수준 | 기본 엔진 금액 |
| BLOCKED | 그 미만 | 매수 금지(0) |

### Rotation을 4개 코인 내부로 제한

- `RACE_HORSE_ALLOWED_SYMBOLS = ['BTC','ETH','SOL','XRP']`.
- 진입·회전 후보는 이 4개만. `isSymbolAllowedForRaceHorse(symbol)` false면 ENTER 거절.
- `rankRaceHorseUniverse(scalpState, signalsBySymbol, entryScoreMin)`로 4코인만 랭킹.
- `shouldRotateHolding(current, candidate, ctx)`에서 허용 코인 아닐 경우 HOLD.

---

## 3) 실전형 Rotation 알고리즘 설계

### Asset score 계산

- `computeRaceHorseAssetScore(assetContext)`:
  - entryScore(정규화), vol_surge/strength_ok/price_break 보너스, orchestrator score, expected_edge, spread 패널티로 0~1 점수.
- `rankRaceHorseUniverse(scalpState, signalsBySymbol, entryScoreMin)`: 4마켓에 대해 위 점수 계산 후 내림차순 정렬.

### 회전 판단 기준

- `shouldRotateHolding(currentHoldingSymbol, candidateSymbol, ctx)`:
  - 동일 코인 → ADD_TO_WINNER 허용.
  - 허용 코인 아님 → HOLD.
  - `sessionRotationCount >= MAX_ROTATIONS_PER_SESSION` → HOLD.
  - `holdSeconds < MIN_HOLD_SEC_BEFORE_ROTATE` → HOLD.
  - 예상 이득(bp) < ROTATION_COST_BP → HOLD.
  - scoreGap < MIN_ROTATION_EDGE_GAP → HOLD.
  - scoreGap ≥ 0.25 → FULL_SWITCH.
  - scoreGap ≥ MIN_ROTATION_EDGE_GAP + (current decay 또는 candidate 고득점) → PARTIAL_SWITCH.

### Full / Partial / Hold / Add-on 조건

- **FULL_SWITCH**: 후보 점수가 현재보다 0.25 이상 높을 때.
- **PARTIAL_SWITCH**: MIN_ROTATION_EDGE_GAP 이상 + 현재 신호 약화 또는 후보 0.6 이상.
- **ADD_TO_WINNER**: 후보 = 현재 보유 최고 코인일 때 추가 매수.
- **HOLD**: 위 조건 미충족 또는 세션/최소보유시간/비용 미충족.

### 비용 반영

- `ROTATION_COST_BP = FEE_RATE_BP + SLIPPAGE_SAFETY_BP` (예: 10+5 bp).
- `shouldRotateHolding`에서 `candidateExpectedEdgeBp` 또는 scoreGap 기반 기대 bp가 ROTATION_COST_BP 미만이면 회전 불허.
- `MIN_EXPECTED_EDGE_BP`(15)로 진입 시 수수료를 넘는 기대값만 허용.

---

## 4) 실제 코드 패치 요약

### raceHorsePolicy.js (확장)

- 티어: FULL_50 / MEDIUM_25 / LIGHT_10 / NORMAL / BLOCKED.
- `getRaceHorseCapitalFraction(tier)`, `evaluateRaceHorseConviction`, `getRaceHorseSizingTier`.
- `computeRaceHorseAssetScore`, `rankRaceHorseUniverse`, `shouldRotateHolding`, `selectBestRotationCandidate`, `evaluateRaceHorseContext`.
- 상수: MIN_ROTATION_EDGE_GAP, MIN_EXPECTED_EDGE_BP, MAX_ROTATIONS_PER_SESSION, MIN_HOLD_SEC_BEFORE_ROTATE, ROTATION_COST_BP.
- 세션 회전: `getSessionRotationCount`, `incrementSessionRotationCount`, `resetSessionRotationCount`.

### scalpEngine.js

- `getBuyOrderAmountKrw`: LIGHT_10(10%) 추가, BLOCKED 시 `amountKrw: 0`, `skipReason: 'RACE_HORSE_BLOCKED'`.

### server.js

- `updateRaceHorseState`: 경주마 창 종료 시 `raceHorsePolicy.resetSessionRotationCount()` 호출.
- ENTER 블록: 허용 코인 검사 후, 보유 중인 허용 코인이 있고 진입 심볼이 그 외일 때 `rankRaceHorseUniverse` + `shouldRotateHolding(bestHolding, symbol, ctx)` 호출. 불허 시 "경주마: 회전 우위 부족" 로그 후 rotationBlock.
- `evaluateRaceHorseConviction`로 티어 계산, BLOCKED 시 거절 로그.
- `useRaceHorseSizing`: FULL_50 / MEDIUM_25 / LIGHT_10 모두 race horse 금액 사용.
- 회전 실행(다른 허용 코인 → 현재 심볼 매수) 성공 시 `incrementSessionRotationCount()`.

### StrategyManager / orchestrator / riskGate

- 기존 동작 유지. 경주마는 server + raceHorsePolicy에서만 제어.

---

## 5) 검증 포인트

| 항목 | 기대 |
|------|------|
| 9시라도 신호 약하면 FULL_50 금지 | 티어가 FULL_50이 아니면 50% 미적용. NORMAL/BLOCKED면 기본 또는 매수 금지. |
| RaceHorse 시간대 + 강한 거래량/상방/score일 때만 FULL_50 | vol_surge+strength+breakout+P0+orch≥0.78+edge → FULL_50. |
| BTC/ETH/SOL/XRP 내부에서만 rotation | 허용 목록 외 심볼 ENTER 거절. rankRaceHorseUniverse는 4코인만. |
| ETH → BTC rotation 가능 | 둘 다 허용, shouldRotateHolding에서 우위·비용 충족 시 FULL_SWITCH/PARTIAL_SWITCH 허용. |
| ETH → DOGE rotation 금지 | DOGE 미허용 → isSymbolAllowedForRaceHorse false → ENTER 거절. |
| cash lock 시 RaceHorse 신규 매수 금지 | state.cashLock?.active면 ENTER 블록 진입 후 즉시 거절 로그, 매수 없음. |
| 청산은 항상 허용 | runExitPipeline / tickExit는 cashLock과 무관 실행. |
| 무리한 손절 회전 금지 | MIN_ROTATION_EDGE_GAP, ROTATION_COST_BP, MIN_HOLD_SEC_BEFORE_ROTATE, MAX_ROTATIONS_PER_SESSION으로 제한. |

---

## 6) 테스트 시나리오

| 시나리오 | 기대 |
|----------|------|
| ETH 보유, BTC 고확신 | BTC 점수·우위·비용 충족 시 회전 허용(FULL_SWITCH/PARTIAL_SWITCH). |
| ETH+BTC 보유, BTC 우위 | BTC가 1위 → ADD_TO_WINNER 또는 ETH 정리 후 BTC 추매(exit pipeline에서 매도). |
| BTC 강세 유지, ETH 약간 우위 | scoreGap < MIN_ROTATION_EDGE_GAP 또는 비용 미충족 시 HOLD, 회전 금지. |
| SOL 손실, XRP 미세 우위 | 우위·기대값 미달 시 HOLD, 억지 손절 회전 금지. |
| cash lock active | 매수 금지, 청산만 수행. |
| restart 후 paused 상태 | ApiAccessPolicy.canPlaceOrder(state) false → 주문 불가, RaceHorse 자동 진입 없음(엔진이 이미 정지). |
