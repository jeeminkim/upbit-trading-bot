# SCALP 모드 전용 로직 (Node.js 구현 명세)

다른 모드(SAFE_FLOW, RELAXED, NORMAL) 없이 **SCALP만** Node.js로 구현할 때 사용하는 최종 명세입니다.  
Python 실전 봇의 `config_scalp` + `scalp_mode` 로직을 타입/단위/공식 기준으로 정리했습니다.

---

## 1. 상수 (기본값)

구현 시 `config` 객체로 두고, 아래 값을 기본값으로 사용하세요.

### 1.1 진입 금지 필터 (P0)

| 키 | 기본값 | 단위/비고 |
|----|--------|-----------|
| `max_spread_pct` | 0.001 | ratio (0.1%). 스프레드 비교는 반드시 ratio 통일 |
| `min_depth_qty` | 0.001 | topN 호가 잔량 하한 |
| `volume_multiplier` | 1.3 | vol_surge: current_10s >= baseline_10s * this |
| `micro_move_threshold` | 0.001 | 가격 변동 비율 이하면 wash/fake → 진입 금지 |
| `tail_body_ratio_limit` | 1.5 | wick > body * this → 진입 금지 |
| `rest_latency_ms_max` | 500 | REST 지연 초과 시 진입 금지 |
| `ws_lag_ms_max` | 1500 | ws_lag_ms = recv_ms - server_ts_ms (clamp ≥ 0) |
| `slippage_shutdown_bps` | 5.0 | 최근 평균 슬리피지 초과 시 진입 금지 |

### 1.2 진입 점수 (P1)

| 키 | 기본값 | 비고 |
|----|--------|------|
| `entry_tick_buffer` | 2 | prev_high + N ticks 돌파 시 price_break |
| `strength_threshold` | 0.55 | strength_proxy_60s 하한 (bid_vol/(bid+ask), den≤0 → 0.5) |
| `obi_threshold` | 0.1 | obi_topN 하한 |
| `entry_score_min` | 4 | 점수 하한. 최대 7점 |
| `require_retest` | false | true면 retest 통과 시에만 진입 (선택) |

### 1.3 청산

| 키 | 기본값 | 비고 |
|----|--------|------|
| `stop_loss_pct` | -0.35 | net 기준 % (수수료 포함) |
| `time_stop_sec` | 150 | 보유 시간 초과 시 무조건 청산 |
| `min_take_profit_floor_pct` | 0.15 | 이 수익 달성 후에만 약화 청산 적용 |
| `weakness_drop_ratio` | 0.20 | strength peak 대비 20% 하락 시 청산 |
| `fee_rate_est` | 0.0005 | 수수료 추정 (net 계산용) |

### 1.4 리스크 캡

| 키 | 기본값 |
|----|--------|
| `max_trades_per_day` | 15 |
| `loss_streak_limit` | 3 |
| `daily_loss_limit_pct` | -1.5 |
| `min_order_krw` | 5000 |
| `slippage_tolerance_pct` | 0.0005 |

---

## 2. Snapshot 필드 (마이크로구조 입력)

아래 키들이 있어야 진입/청산 판단이 가능합니다. 단위·범위는 문서 기준으로 통일하세요.

```ts
interface Snapshot {
  // 스프레드 (비교 시 ratio 통일)
  spread_ratio?: number;   // 0~0.02. 없으면 spread_pct * 0.01
  spread_pct?: number;
  median_spread_60s?: number;

  // 호가 깊이
  topN_depth_bid?: number;
  topN_depth_ask?: number;

  // OBI·강도 (0~1, -1~1)
  obi_topN?: number;              // -1~1
  strength_proxy_60s?: number;     // 0~1. bid_vol/(bid_vol+ask_vol)
  strength_for_score?: number;     // flow_anomaly 시 0.5 클램프 가능
  strength_peak_60s?: number;      // 청산 시 peak 대비 하락 비교용

  // 거래량 (KRW)
  vol_now_krw_10s?: number;       // 또는 vol_krw_10s, krw_notional_10s
  vol_baseline_krw_10s_used?: number;  // 또는 vol_surge_baseline_notional
  vol_surge_final?: boolean;      // 있으면 vol_surge 판정으로 직접 사용 가능
  rolling_vol_10s?: number;
  rolling_vol_60s?: number;

  // 지연
  ws_lag_ms?: number;             // recv_ms - server_ts_ms, clamp >= 0
  rest_latency_ms?: number;

  // 차단 플래그
  spread_anomaly_blocked?: boolean;
  flow_anomaly_blocked?: boolean;

  // 가격
  mid_price?: number;
  last_trade_price?: number;
  best_bid?: number;
  best_ask?: number;
}
```

---

## 3. 진입 흐름 (순서 고정)

### Step 0: 계정/포지션

- `budget >= min_order_krw`, `positions_count < max_open_positions`, 후보 티커 존재.

### Step 1: P0 게이트 (check_entry_gates)

진입 **금지** 조건 (하나라도 만족하면 진입 불가):

1. **스냅 없음** → `BLOCK_LIQUIDITY`
2. **spread_anomaly_blocked || flow_anomaly_blocked** → `BLOCK_LIQUIDITY`
3. **스프레드**  
   `spread_ratio = snapshot.spread_ratio ?? (snapshot.spread_pct * 0.01)`  
   `maxSpread = max(profile.max_spread_pct, median_spread_60s * 1.5)` (median 있을 때)  
   `spread_ratio > maxSpread` → `BLOCK_SPREAD`
4. **호가 깊이**  
   `topN_depth_bid < min_depth_qty || topN_depth_ask < min_depth_qty` → `BLOCK_LIQUIDITY`
5. **VPA (선택)**  
   vol_now >= vol_prev * volume_multiplier 인데, micro 봉에서 `|close-open|/open < micro_move_threshold` 이면 → `BLOCK_VPA`
6. **윅**  
   body = |close-open|, tail = upper_tail + lower_tail  
   `body > 0 && tail > body * tail_body_ratio_limit` → `BLOCK_WICK`
7. **지연**  
   `rest_latency_ms > rest_latency_ms_max` → `BLOCK_LAG`  
   `ws_lag_ms > ws_lag_ms_max` → `BLOCK_LAG`
8. **슬리피지**  
   `realized_slippage_bps_avg > slippage_shutdown_bps` → `BLOCK_SLIPPAGE`

### Step 2: Vol surge

```ts
function getVolSurge(snapshot: Snapshot, profile: Profile): boolean {
  if (snapshot.vol_surge_final != null) return !!snapshot.vol_surge_final;
  const vol10s = snapshot.vol_now_krw_10s ?? snapshot.vol_krw_10s ?? snapshot.krw_notional_10s ?? 0;
  const baseline = snapshot.vol_baseline_krw_10s_used ?? snapshot.vol_surge_baseline_notional ?? 0;
  if (baseline <= 0) return false;
  return vol10s >= baseline * profile.volume_multiplier;
}
```

### Step 3: Price break (prev_high 돌파)

- `prev_high`: 이전 1m 봉 high 또는 최근 N초 high (룩어헤드 금지).
- `current_price > prev_high + entry_tick_buffer ticks` 이면 `price_break = true`.
- 틱 크기는 호가단위로 계산.

### Step 4: Entry score (0~7)

```ts
function entryScore(snapshot: Snapshot, priceBreak: boolean, volSurge: boolean, profile: Profile): number {
  let score = 0;
  if (volSurge) score += 2;
  const strength = snapshot.strength_for_score ?? snapshot.strength_proxy_60s ?? 0;
  if (strength >= profile.strength_threshold) score += 2;
  const obi = snapshot.obi_topN ?? 0;
  if (obi >= profile.obi_threshold) score += 2;
  if (priceBreak) score += 1;
  return score;  // max 7
}
```

- **진입 조건**: `score >= profile.entry_score_min` (기본 4).
- `require_retest === true` 이면, retest 로직 통과 시에만 진입 (별도 정의).

### Step 5: 스프레드 최종 확인

- 주문 직전 `spread_ratio <= profile.max_spread_pct` (또는 동적 한도) 확인.
- 초과 시 주문 미전송.

---

## 4. 청산 (should_exit_scalp)

아래 순서로 판단. 하나라도 만족하면 청산.

1. **타임스탑**  
   `hold_sec >= time_stop_sec` → 청산, reason `"time_stop"`.

2. **손절**  
   `net_return_pct = (current - entry)/entry * 100 - fee_rate_est * 100 * 2`  
   `net_return_pct <= stop_loss_pct` → 청산, reason `"stop"`.

3. **약화 (수익 구간에서만)**  
   `net_return_pct >= min_take_profit_floor_pct` 일 때:  
   - `strength <= strength_peak_60s * (1 - weakness_drop_ratio)` → 청산, reason `"weakness"`.  
   - `obi_topN < -0.3` → 청산, reason `"weakness"`.

---

## 5. 요약 체크리스트 (Node.js 구현 시)

- [ ] P0 게이트 8개 순서대로 적용 (스프레드 단위 ratio 통일).
- [ ] Vol surge: `vol_surge_final` 우선, 없으면 baseline * volume_multiplier.
- [ ] Entry score: vol_surge 2 + strength_ok 2 + obi_ok 2 + price_break 1, min 4.
- [ ] prev_high는 룩어헤드 없이 (과거 봉 또는 과거 구간 high만).
- [ ] 청산: time_stop → stop_loss(net) → weakness(tp_floor 달성 후).
- [ ] 리스크 캡: 일일 거래 횟수, 연속 손실, 일일 손실 한도, 최소 주문 금액, 슬리피지 한도.

이 문서만 따라 구현하면 SCALP 단일 모드로 동작하는 Upbit 스캘핑 봇을 Node.js에서 재현할 수 있습니다.

---

## 6. Node.js 구현용 최종 프롬프트 (복사용)

아래 블록 전체를 복사해 AI 또는 개발 지시용으로 사용하세요.

```
당신은 Upbit 현물 스캘핑 자동매매 봇을 Node.js(TypeScript 권장)로 구현하는 개발자입니다.

【제약】
- SCALP 모드만 구현합니다. SAFE_FLOW, RELAXED, NORMAL 등 다른 서브모드는 사용하지 않습니다.
- 업비트 Open API(현물)만 사용하며, 주문/잔고/호가/체결 데이터는 공식 API 또는 공식 WebSocket으로 처리합니다.

【명세 참조】
다음 로직 명세를 정확히 따르세요.
- 진입: (1) P0 게이트 8개 순서대로 적용 → (2) vol_surge 판정(baseline * volume_multiplier) → (3) prev_high 돌파로 price_break → (4) entry_score 0~7 계산(vol_surge 2 + strength_ok 2 + obi_ok 2 + price_break 1) → score >= entry_score_min(기본 4)일 때만 진입 후보.
- 스프레드 비교는 반드시 ratio 단위로 통일(spread_ratio 또는 spread_pct*0.01). max_spread_pct(기본 0.001) 및 동적 한도 max(base, median_spread_60s*1.5) 적용.
- 청산: 타임스탑(기본 150초) → net 손절(기본 -0.35%, 수수료 포함) → tp_floor(기본 0.15%) 달성 후 strength/obi 약화 시 청산.
- 상수·스냅샷 필드·P0 항목·entry_score·청산 조건은 반드시 제공된 SCALP_LOGIC_FOR_NODEJS.md 문서의 섹션 1~5와 일치하게 구현하세요.

【산출물】
- 프로젝트 구조(패키지 매니저, 설정 파일, 엔트리 포인트).
- 설정 가능한 SCALP 상수(config 또는 .env).
- Snapshot 타입 및 마이크로구조 수집(호가/체결/거래량, 10s baseline, OBI, strength, spread, ws_lag 등)을 만드는 모듈.
- P0 게이트 함수(check_entry_gates), vol_surge, entry_score, 진입 후보 선정 로직.
- 청산 판단 함수(should_exit_scalp: time_stop, stop_loss, weakness).
- Upbit API 연동(주문/잔고/가격), 리스크 캡(일일 거래 횟수, 연속 손실, 일일 손실 한도, 최소 주문 KRW, 슬리피지 한도) 적용.
- (선택) WebSocket 실시간 스트림으로 스냅샷 갱신 후 주기적으로 진입/청산 루프 실행.

문서 경로: 프로젝트 내 docs/SCALP_LOGIC_FOR_NODEJS.md 를 참조하거나, 위 요약과 아래 첨부된 명세를 따릅니다.
```

이 프롬프트와 본 문서(SCALP_LOGIC_FOR_NODEJS.md)를 함께 전달하면 SCALP 단일 모드 Node.js 봇 구현이 가능합니다.
