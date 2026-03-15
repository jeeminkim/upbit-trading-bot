# 다음 단계 검증 체크리스트

아키텍처 이식 시 아래 항목을 반드시 지키면, 기존 동작·수익률·정지 동작이 유지됩니다.

---

## 1. RiskEngine / ExecutionEngine / PositionEngine

### 타입 계약 (src/shared/types)

| 엔진 | 사용 타입 | 파일 |
|------|-----------|------|
| RiskEngine | `RiskVerdict` | `src/shared/types/Risk.js` |
| ExecutionEngine | `ExecutionPlan`, `ExecutionSlice` | `src/shared/types/Execution.js` |
| PositionEngine | `Position` | `src/shared/types/Position.js` |
| MarketData | `MarketSnapshot`, `Candle` | `src/shared/types/Market.js` |
| SignalEngine | `SignalDecision` | `src/shared/types/Signal.js` |

- **확인**: 엔진 간 입출력은 위 타입(JSDoc)을 준수할 것.
- **위치**: `dashboard/src/shared/types/*.js`

### 수익률 계승 (PositionEngine)

- **명세**: `src/domain/position/PROFIT_CALC_SPEC.md`
- **필드 유지**:
  - `totalBuyKrwForCoins` (총매수, KRW 제외)
  - `evaluationKrwForCoins` (코인 평가금 합계)
- **계산식**: `(evaluationKrwForCoins - totalBuyKrwForCoins) / totalBuyKrwForCoins * 100`
- **현재 구현 참고**: `server.js` 내 `getProfitPct(assets)` (약 577~584라인)

**확인**: PositionEngine 또는 집계 레이어에서 위 필드명·계산식을 그대로 사용할 것. 대시보드/디스코드 임베드는 이 필드를 기준으로 함.

---

## 2. TradingCycle / TradingOrchestrator

### 정지 시 루프 해제 재점검

- **현재 구현**: `domain/trading/TradingEngine.js`
  - `stop()` → `_clearAll()` 호출
  - `_clearAll()`: `intervalIds` 전부 `clearInterval`, `timeoutIds` 전부 `clearTimeout`, `_running = false`
  - 등록 구간: 메인 폴, FX, MarketAnalyzer 중기/일봉, persist, rejectEmit, cleanup, 4시 체크 (총 8개 setInterval)

**확인**: TradingCycle·TradingOrchestrator로 이 구조를 대체할 때 다음을 보장할 것.

1. 모든 주기 작업의 `setInterval`/`setTimeout` ID를 한 곳에서 보관.
2. 정지(Stop) 시 해당 ID에 대해 **모두** `clearInterval`/`clearTimeout` 호출.
3. `EngineStateStore.update({ serviceStopped: true, botEnabled: false })` 등 상태 정지 플래그 설정.

---

## 3. 테스트: SignalEngine 연동

### 실행 방법

```bash
cd dashboard
USE_SIGNAL_ENGINE=1 node server.js
```

### 확인 사항

- 기동 시 로그에 `[Arch] SignalEngine (ScalpStrategy) 로드됨 — USE_SIGNAL_ENGINE=1` 출력.
- 스칼프 사이클이 **기존과 동일**하게 동작:
  - 대시보드 코인 카드의 진입 점수·P0 뱃지가 기존과 같이 갱신되는지.
  - `USE_SIGNAL_ENGINE=0`(또는 미설정)과 `USE_SIGNAL_ENGINE=1`일 때 결과가 동일한지 비교.

### 실패 시

- `[Arch] bootstrap SignalEngine 로드 실패:` 로그가 나오면 `src/composition/bootstrap.js` 및 `src/domain/signal/*` require 경로 확인.
- 스칼프 점수/뱃지가 비어 있으면 `runScalpCycle` 내 `signalEngineResult.byMarket[market]` 및 `pipeline` 대입 로직 확인.

---

## 요약

| 항목 | 준수 내용 |
|------|-----------|
| Risk/Execution/Position 엔진 | `src/shared/types` 계약 사용 |
| PositionEngine 수익률 | `PROFIT_CALC_SPEC.md` + `totalBuyKrwForCoins`, `evaluationKrwForCoins` 유지 |
| TradingCycle/Orchestrator | 정지 시 모든 루프 `stop()`/`clearInterval` 재점검 |
| 테스트 | `USE_SIGNAL_ENGINE=1 node server.js` 로 스칼프 사이클 동작 확인 |
