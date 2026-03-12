# Edge Layer Production Safety — 요약·수정·테스트·운영

## 1. 현재 위험 포인트 3개 요약

| # | 위험 포인트 | 내용 |
|---|-------------|------|
| 1 | **Volume Surge 계산 왜곡** | `acc_trade_price_24h` 델타를 틱마다 버킷에 넣던 구조라, 틱 간격이 들쭉날쭉하면 "최근 10초 거래량" 의미가 깨짐. |
| 2 | **EdgeEstimator factor 정규화 불완전** | signalScore, regimeScore, liquidityFactor, slippageRiskInverse 등이 0~1 밖으로 나가거나 null/NaN일 때 edgeScore·의사결정 왜곡 가능. |
| 3 | **StrategyOrchestrator normalization 왜곡** | z-score 정규화에서 std=0, 샘플 부족, outlier 시 한 전략만 과도하게 선택되거나 fallback 없이 비정상 값 사용. |

---

## 2. 수정이 필요한 파일 목록

| 파일 | 수정 목적 |
|------|------------|
| `lib/strategy/edge/volumeSurge.js` | 10초 **시간 버킷** 집계, 5분 윈도우, 분모 0/히스토리 부족/abnormal spike 처리, recentVolume/avgBucketVolume/surgeValue 로그 |
| `lib/strategy/edge/EdgeEstimator.js` | factor·edgeScore clamp(0~1), null/NaN fallback, raw/normalized 로그, wouldReject·reasonCode·context |
| `lib/strategy/signalComparator.js` | min_samples/std epsilon fallback, z-score clamp 후 0~1 재매핑, fallback 시 raw 사용·reason 로그·normalizationFallbackCount |
| `lib/strategy/edge/edgeMetrics.js` | normalization_fallback_count (전략별) 추가, getMetrics/resetMetrics 반영 |
| `lib/strategy/edge/liquidityFilter.js` | observe_only 시 wouldReject 필드 추가 (선택) |
| `lib/config.default.js` | (신규) lib/strategy/edge에서 require('../../config.default') 해결용 re-export |

---

## 3. 각 파일별 수정 목적

- **volumeSurge.js**: 틱 간격과 무관하게 `bucketKey = Math.floor(timestampMs / 10000)` 기준으로 10초 버킷 누적, 최근 10초 = 현재 버킷 합계, 5분 평균 = 최근 5분 10초 버킷 평균, division by zero·history 부족·abnormal spike 시 neutral fallback 및 로그.
- **EdgeEstimator.js**: 모든 factor와 최종 edgeScore를 0~1 clamp, null/undefined/NaN → 0, details에 rawFactors·normalizedFactors, observe_only에서 wouldReject 전달, reasonCode·context 로그.
- **signalComparator.js**: min_samples 미만·std&lt;epsilon이면 raw score 반환 + incrementNormalizationFallback, z-score clamp 후 `normalized = clamp(0.5 + z*scale, 0, 1)` 재매핑, raw/normalized·fallback reason 로그.
- **edgeMetrics.js**: edgePassCount, edgeRejectCount, liquidityRejectCount, volumeRejectCount 유지, normalizationFallbackCount(전략별) 추가.

---

## 4. 실제 코드 수정안

### 4.1 Volume Surge — 시간 버킷

- **버킷 키**: `bucketKey = Math.floor(timestampMs / 10000)` (10초 단위).
- **pushBucket**: 동일 bucketKey면 기존 버킷에 vol 누적, 아니면 새 버킷 push. 5분(30버킷) 초과 구간 삭제.
- **compute**: `recentVolume` = 현재 bucketKey 버킷의 vol, `avgBucketVolume` = (최근 5분 버킷 vol 합) / max(1, 버킷 수), `surgeValue = recentVolume / avgBucketVolume` (분모 0·비정상 값·히스토리 부족 시 neutral fallback, 상한 clamp).
- **check**: observe_only/soft_gate는 `allowed: true` 유지, `wouldReject`·reasonCode·context 반환. hard_gate는 value &lt; threshold 시 `allowed: false`, reasonCode·context.

(구현은 `lib/strategy/edge/volumeSurge.js`에 반영됨.)

### 4.2 EdgeEstimator — clamp/정규화

- **clamp01**: `v == null || NaN` → 0, 그 외 `Math.max(0, Math.min(1, Number(v)))`.
- **evaluate**: signalScore, regimeScore, volatilityFactor, liquidityFactor, slippageRiskInverse 각각 clamp01 적용 후 가중합, **edgeScore도 clamp01**.
- **details**: rawFactors(원본), normalizedFactors(clamp 후).
- **observe_only**에서 threshold 미만이면 decision='PASS', wouldReject=true, reasonCode·context 로그.

(구현은 `lib/strategy/edge/EdgeEstimator.js`에 반영됨.)

### 4.3 StrategyOrchestrator normalization 보강

- **min_samples** 미만 → raw score 반환, incrementNormalizationFallback(strategy), reason 'MIN_SAMPLES' 로그.
- **std &lt; epsilon** → raw score 반환, incrementNormalizationFallback(strategy), reason 'STD_EPSILON' 로그.
- **z-score**: `zClamped = clamp(z, -clampVal, clampVal)`, `normalized = clamp(0.5 + zClamped * (0.5/clampVal), 0, 1)`.

(구현은 `lib/strategy/signalComparator.js`에 반영됨.)

### 4.4 Metrics/Counter 예시

```js
// edgeMetrics.getMetrics() 반환 예시
{
  edge_pass_count: { BTC: 10, ETH: 5 },
  edge_reject_count: { BTC: 2 },
  liquidity_reject_count: {},
  volume_reject_count: { BTC: 1 },
  normalization_fallback_count: { SCALP: 3, REGIME: 2 }
}
```

---

## 5. 테스트 파일 목록

| 파일 | 용도 |
|------|------|
| `tests/edge-layer-production-safety.test.js` | Volume Surge 시간 버킷, EdgeEstimator clamp/observe_only·hard_gate, normalization fallback·메트릭, observe_only 계약 |

실행: `node tests/edge-layer-production-safety.test.js` (dashboard 디렉터리에서 실행 권장).

---

## 6. 테스트 체크리스트 표

| 구분 | 항목 | 기대 |
|------|------|------|
| Volume Surge | getBucketKey 10초 단위 | bucketKey = floor(ts/10000) |
| Volume Surge | pushBucket 같은 10초 구간 누적 | 동일 bucketKey면 vol 합산 |
| Volume Surge | 틱 간격 불규칙해도 버킷 일관 | 1초/3초/7초 틱도 같은 버킷에 누적 |
| Volume Surge | 버킷 5개 미만 fallback | value=neutral, fallback=true |
| Volume Surge | 분모 0 없음 | avgBucketVolume floor 또는 fallback |
| Volume Surge | recentVolume 현재 10초 버킷 기준 | 현재 bucketKey 버킷 vol |
| Volume Surge | observe_only allowed | 항상 true |
| Volume Surge | hard_gate value&lt;threshold | allowed=false, reasonCode |
| Volume Surge | 로그 필드 | recentVolume, avgBucketVolume, surgeValue |
| EdgeEstimator | factor 정상 시 edgeScore | 0~1, decision PASS/REJECT |
| EdgeEstimator | factor &gt;1 또는 &lt;0 | clamp 후 0~1 |
| EdgeEstimator | factor null/undefined/NaN | fallback(0), edgeScore 0~1 |
| EdgeEstimator | observe_only wouldReject | decision=PASS, wouldReject=true |
| EdgeEstimator | hard_gate threshold 미만 | decision=REJECT |
| EdgeEstimator | details | rawFactors, normalizedFactors |
| Normalization | sample 부족 | raw score, fallback count 증가 |
| Normalization | 정규화 후 0~1 | normalized in [0,1] |
| Normalization | normalizationFallbackCount | getMetrics()에 존재 |
| 통합 | volumeSurge observe_only | allowed=true |
| 통합 | liquidityFilter observe_only | allowed=true |
| 메트릭 | edgePass/Reject, volumeReject, normalization_fallback | getMetrics()에 존재 |

---

## 7. 통합 테스트 시나리오 (8개)

| # | 시나리오 | 기대 | 검증 |
|---|----------|------|------|
| 1 | 강한 signal + 좋은 liquidity + 정상 volume surge + 정상 regime | pass | Edge pass + volume pass + liquidity pass → 주문 체인 진행 |
| 2 | signal 강하지만 edgeScore 미달 | observe_only=PASS, hard_gate=REJECT | EdgeEstimator 테스트에서 wouldReject·decision 분리 검증 |
| 3 | liquidity 충분, volume surge 부족 | hard_gate에서 reject | volumeSurge.check(state, market, symbol, 'hard_gate') → allowed=false |
| 4 | tick 간격 왜곡으로 volume surge 잘못 높아질 수 있는 케이스 | 버킷 기준 계산 후 false trigger 방지 | pushBucket 동일 bucketKey 누적 테스트, compute recentVolume=현재 버킷 |
| 5 | normalization warm-up 구간 | raw score fallback | min_samples 미만 시 normalizeStrategyScore === rawScore, fallback count 증가 |
| 6 | factor 하나가 NaN/undefined | neutral fallback + reason/log | EdgeEstimator evaluate 시 normalized 0, details.rawFactors 기록 |
| 7 | observe_only에서 wouldReject=true | 실제 주문 체인 유지(allowed=true) | volumeSurge/liquidityFilter/EdgeEstimator observe_only → allowed=true |
| 8 | Edge 통과, RiskGate 차단 | EDGE_* vs RISK_* 사유 구분 | 로그/verdict.reasons에 RiskGate 사유만 노출, Edge는 통과 상태로 기록 |

---

## 8. 테스트 코드 예시

(핵심만 발췌.)

```js
// Volume Surge: 같은 10초 버킷 누적
run('pushBucket: 같은 10초 구간이면 누적', () => {
  const state = {};
  pushBucket(state, 'KRW-BTC', 100);
  pushBucket(state, 'KRW-BTC', 50);
  const buckets = state.volumeBuckets10s['KRW-BTC'];
  assert(buckets[buckets.length - 1].vol === 150);
});

// EdgeEstimator: observe_only에서 wouldReject여도 decision=PASS
run('observe_only: wouldReject=true여도 allowed(decision=PASS) 유지', () => {
  const r = EdgeEstimator.evaluate(
    { signalScore: 0.1, regimeScore: 0.1, volatilityFactor: 0.5, liquidityFactor: 0.5, slippageRiskInverse: 0.5 },
    { mode: 'observe_only', symbol: 'XRP', threshold: 0.9 }
  );
  assert(r.decision === 'PASS');
  assert(r.wouldReject === true);
});

// Normalization fallback count
run('normalizationFallbackCount 집계', () => {
  edgeMetrics.resetMetrics();
  for (let i = 0; i < 2; i++) normalizeStrategyScore('SCALP', 0.5);
  const m = edgeMetrics.getMetrics();
  assert(m.normalization_fallback_count != null);
});
```

---

## 9. 검출 가능한 실패 시나리오

| 시나리오 | 검출 방법 | 수정 방향 |
|----------|-----------|-----------|
| Volume surge false positive (틱 몰림으로 surge 과대) | 버킷 기준 계산 후에도 불규칙 틱 테스트에서 surge 과대 | denominator floor 강화, MAX_SURGE_CLAMP 낮추기, threshold 재조정 |
| Volume surge false negative (진입 기회 과소) | observe_only 로그에서 wouldReject 비율 과다 | threshold 완화, MIN_BUCKETS_FOR_AVG 조정, neutral fallback 유지 |
| Edge 과차단 (진입이 너무 막힘) | edgeRejectCount 급증, observe_only wouldReject 다수 | threshold 낮추기, observe_only 연장, factor weight 완화 |
| Edge 과통과 (나쁜 신호도 통과) | edgePassCount만 높고 수익률 하락 | threshold 상향, hard_gate 전환, factor weight 조정 |
| Normalization 왜곡 (한 전략만 선택) | normalized score가 한쪽으로 치우침 | min_samples 증가, clamp 강화, remap scale 조정, winsorize 검토 |
| observe_only인데 주문 차단 발생 | allowed=false가 observe_only에서 나옴 | allowed/wouldReject 계약 재정의, observe_only 분기 재확인 |
| RiskGate 차단과 Edge 차단 구분 불가 | 로그에 EDGE_* vs RISK_* 혼재 | reasonCode·context에 레이어 명시, 5분 summary 메트릭으로 EDGE_* / RISK_* 구분 |

---

## 10. 실패 시 수정 제안 (최소 수정 기준)

| 문제 | 최소 수정 |
|------|-----------|
| volume surge false positive | bucket 집계 유지, denominator = max(1, count), surgeValue 상한 clamp 유지, threshold 상향 |
| volume surge false negative | threshold 완화, MIN_BUCKETS_FOR_AVG 감소(주의), volumeSurgeNeutralFallback 검토 |
| edge 과차단 | EDGE_THRESHOLD 낮추기, observe_only 기간 연장, factor weight에서 signal 비중 소폭 상향 |
| edge 과통과 | EDGE_THRESHOLD 상향, hard_gate 전환, factor weight 조정 |
| normalization 왜곡 | normalizerMinSamples 증가, normalizerOutlierClamp 감소, remap scale 조정, 필요 시 winsorize |
| observe_only 오작동 | allowed는 항상 true, wouldReject·reasonCode만 별도 필드로, 호출부에서 allowed만 사용해 차단 여부 결정 |
| 로그 부족 | structured context(asset, strategy, edgeScore, rawScore, normalizedScore, fallbackUsed) 추가, 5분 summary 로그 도입 |

---

## 11. 운영 배포 전 검증 순서

1. **단위 테스트**: `node tests/edge-layer-production-safety.test.js` 전 항목 통과.
2. **observe_only 배포**: EDGE_LAYER_MODE=observe_only, USE_EDGE_LAYER=1 로 기동, wouldReject·reasonCode 로그 확인, **실제 주문 차단 없음** 확인.
3. **메트릭 확인**: edgePassCount, edgeRejectCount, volumeRejectCount, normalizationFallbackCount 로그/엔드포인트로 수집 가능한지 확인.
4. **soft_gate 전환**(선택): 경고만 로그, allowed=true 유지 확인.
5. **hard_gate 전환**: threshold·자산별 설정 검토 후 전환, 거절 비율·수익성 모니터링.

---

## 12. 롤백 판단 기준

- **즉시 롤백**: observe_only 모드에서 실제 주문이 차단되거나, 에러로 인해 매매 로직이 중단되는 경우.
- **검토 후 롤백**: hard_gate에서 거절률이 설정 대비 비정상적으로 높거나, 수익성·체결률이 기대 이하로 떨어지는 경우 (threshold·모드 복귀 후 재배포).
- **코드 롤백**: volumeSurge/EdgeEstimator/signalComparator 수정 이전 커밋으로 되돌리고, config(EDGE_LAYER enabled/mode)만 유지해 기능 비활성화 가능.

---

## 13. 배포 후 모니터링 포인트

| 항목 | 방법 |
|------|------|
| reject 원인 구분 | reasonCode: EDGE_SCORE_TOO_LOW, VOLUME_SURGE_TOO_LOW, ORDERBOOK_LIQUIDITY_INSUFFICIENT, NORMALIZATION_FALLBACK_USED 등 집계 |
| 자산별 reject | edge_reject_count, volume_reject_count, liquidity_reject_count 자산별 비율 |
| normalization fallback | normalization_fallback_count (SCALP/REGIME) — 과다 시 min_samples·std epsilon 검토 |
| 로그 레벨 제안 | info=최종 decision, debug=factor 상세, warn=reject |
| 5분 summary | 가능 시 edgePass/Reject, volumeReject, liquidityReject, normalizationFallback 5분 단위 합계 로그 |

---

## Logging / Reason Code 요구사항 정리

- **reject 시**: reasonCode 필수, context(asset, strategy, edgeScore, threshold, signalScore, regimeScore, liquidityFactor, slippageRiskInverse, recentVolume, avgBucketVolume, surgeValue, rawScore, normalizedScore, fallbackUsed 등) 포함.
- **observe_only**: allowed=true 유지, wouldReject·shadowReject는 별도 필드로만 전달.
- **레벨**: info=최종 decision, debug=factor detail, warn=reject. 5분 단위 summary 메트릭 권장.
