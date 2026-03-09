# 전략 오케스트레이터 (Orchestrator)

SCALP 봇과 REGIME 봇을 병렬로 평가하고, 더 우수한 조건을 제시한 1건만 실제 진입하도록 하는 레이어입니다.

---

## 1. 생성/수정 파일 목록

### 새로 생성
- `lib/strategy/signalSchema.js` - 공통 시그널 타입/유틸
- `lib/strategy/signalNormalizer.js` - SCALP/REGIME 원시 출력 → UnifiedSignal 정규화
- `lib/strategy/scalpSignalProvider.js` - SCALP 시그널 제공
- `lib/strategy/regimeSignalProvider.js` - REGIME 시그널 제공
- `lib/strategy/signalComparator.js` - 비교 점수·합의(consensus)·선택 로직
- `lib/strategy/orchestrator.js` - 틱 실행·로그·히스토리·진입 기록
- `lib/risk/riskGate.js` - 안전장치 (포지션 수, 시간당 진입, 쿨다운, 일일손실, 연속손실, 데이터 품질)
- `lib/risk/positionConflictResolver.js` - 포지션 소유 전략·충돌 방지
- `public/orchestrator.html` - 오케스트레이터 전용 UI
- `data/orchestrator_history.jsonl` - 실행 시 자동 생성
- `docs/ORCHESTRATOR.md` - 본 문서

### 수정
- `server.js` - orchestrator require, ORCH_PAGE_ONLY, `/orchestrator`·API 라우트, poll 내 오케스트레이터 tick 및 ENTER 시 주문 실행, state.accounts·lastOrchestratorResult

---

## 2. 공통 시그널 스키마 (UnifiedSignal)

두 전략 출력을 다음 형식으로 통일합니다.

```ts
{
  strategy: "SCALP" | "REGIME",
  symbol: "BTC" | "ETH" | "SOL" | "XRP",
  side: "BUY" | "SELL" | "NONE",
  score: number,           // 0~1
  confidence: number,      // 0~1
  expected_edge: number,   // 0~1
  risk_level: number,      // 0~1
  regime_context: string | null,  // REGIME 전용 (TREND_UP 등)
  reasons: string[],
  diagnostics: object,
  timestamp: number,
  expected_horizon?: "short" | "medium" | "long"
}
```

- **SCALP**: `state.scalpState` + profile 기반으로 진입 후보만 필터해 정규화.
- **REGIME**: `regimeDetector.readLastLines()` + MPI 기반으로 심볼별 최신 regime을 정규화.

---

## 3. orchestrator_history 저장 예시

`data/orchestrator_history.jsonl` (한 줄당 1건):

```json
{"timestamp":1710000000,"scalp_signal":{"strategy":"SCALP","symbol":"BTC","side":"BUY","score":0.72,"confidence":0.68,"expected_edge":0.65,"risk_level":0.35,"regime_context":null,"reasons":["price_break","vol_surge"],"diagnostics":{"p0Allowed":true,"quantityMultiplier":1},"timestamp":1710000000},"regime_signal":{"strategy":"REGIME","symbol":"BTC","side":"BUY","score":0.76,"confidence":0.74,"regime_context":"TREND_UP","reasons":["regime_trend_up"],"diagnostics":{"regime":"TREND_UP"},"timestamp":1710000000},"chosen_strategy":"REGIME","final_action":"ENTER","final_score":0.81,"reason":"higher confidence and lower risk"}
```

```json
{"timestamp":1710000010,"scalp_signal":null,"regime_signal":null,"chosen_strategy":"NONE","final_action":"SKIP","final_score":0,"reason":"no qualifying signal"}
```

---

## 4. /orchestrator 페이지 예시

- **현재 SCALP 시그널** · **현재 REGIME 시그널** (JSON 요약)
- **최종 선택**: 선택 전략(SCALP/REGIME/CONSENSUS/NONE), 액션(ENTER/SKIP), 최종 점수, 사유, SKIP 시 사유
- **최근 의사결정 로그 20건** (태그 + 메시지)
- **orchestrator_history 최근 20건** (타임스탬프, chosen_strategy, final_action, reason)

3초마다 `/api/orchestrator/state`, `/api/orchestrator/history`로 갱신.

---

## 5. 실행 방법

- **일반**: `node server.js` 후 브라우저에서 `http://localhost:3000/orchestrator` 접속.
- **오케스트레이터 단독 진입**: `ORCH_PAGE_ONLY=1 node server.js` → `/` 접속 시 `/orchestrator`로 리다이렉트.
- **자동 진입**: 대시보드에서 "엔진 가동" 후, 오케스트레이터가 `action === 'ENTER'`를 반환하면 해당 심볼 1건만 매수 실행. (SCALP 단독 BUY_SIGNAL 로그는 그대로 두고, 실제 주문은 오케스트레이터 경로만 사용.)

---

## 6. 테스트 시나리오 예시

1. **둘 다 미달**  
   SCALP·REGIME 모두 threshold 미만 → `chosen_strategy: NONE`, `final_action: SKIP`, 주문 없음.

2. **SCALP만 유효**  
   REGIME 없음 또는 NONE → SCALP 후보 1개만 선택, risk gate 통과 시 ENTER, SCALP로 기록.

3. **REGIME만 유효**  
   SCALP 후보 없음 → REGIME 후보 1개만 선택, 통과 시 ENTER, REGIME로 기록.

4. **동일 심볼 BUY·BUY (합의)**  
   SCALP·REGIME 모두 같은 심볼 BUY, score 차이 ≤ 0.15 → consensus 보너스 적용, 한 쪽 선택 또는 CONSENSUS, 1건만 ENTER.

5. **동일 심볼 BUY·BUY (비합의)**  
   같은 심볼이지만 score 차이 큼 → orchestrator_score 높은 쪽만 선택, 1건 ENTER.

6. **서로 다른 심볼**  
   SCALP=A, REGIME=B → 점수·리스크 비교해 한 심볼만 ENTER.

7. **안전장치**  
   max_open_positions 초과, hourly_entry_limit 초과, duplicate_cooldown, daily_loss_limit, consecutive_loss_halt, ws_lag → SKIP, skip_reasons에 사유 기록.

8. **포지션 충돌**  
   이미 다른 전략이 보유한 심볼에 진입 시도 → allowEntry 차단, SKIP.

---

## 7. 로그 태그

- `[SCALP_SIGNAL]` · `[REGIME_SIGNAL]` - 현재 후보 시그널
- `[CONSENSUS]` - 동일 심볼 합의 시
- `[ORCH_COMPARE]` - scalp/regime/final 점수, chosen
- `[ORCH_DECISION]` - action, symbol, strategy, reason
- `[SKIP_REASON]` - SKIP 시 사유
- `[CONFLICT]` - 포지션 충돌
