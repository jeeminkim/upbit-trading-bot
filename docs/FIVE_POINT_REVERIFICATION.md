# 5가지 재검증 (코드 레벨) — 안전/주의/위험 분류

방금 반영한 수정안 기준으로 아래 5가지를 코드 레벨에서 재검증하고, **확실히 안전 / 주의 필요 / 위험** 세 단계로 정리함.

---

## 1. 초 scalp lightweight risk gate: 신규 진입만 막는지 vs exit까지 막는지

### 질문
- 보유 포지션이 있을 때 `ws_lag` 또는 `daily_loss_limit`에 걸려도 **청산 로직은 계속 도는지**?
- exit까지 스킵되면 **위험**으로 분류.

### 코드 흐름 (`lib/scalp_independent/scalpRunner.js`)

```javascript
async function tick(ctx) {
  scalpState.checkExpiry();
  if (!scalpState.isRunning || scalpState.priorityOwner !== 'SCALP') return;
  if (scalpState.isRiskHalt()) { ... return; }
  if (scalpState.activePosition) {
    await tickExit(ctx);   // ← 보유 중이면 항상 먼저 청산 처리
    return;
  }
  // ---------- 아래는 activePosition 없을 때만 실행 ----------
  const gateCtx = { ... };
  const globalVerdict = riskGate.checkScalpLight(gateCtx, '', {});
  if (!globalVerdict.allowed) {
    logLine('[SCALP_RISK] ...');
    return;
  }
  // 진입 로직 (getTickers, decide, placeMarketBuyByPrice 등)
}
```

- **보유 포지션이 있는 경우**: `scalpState.activePosition`이 truthy → **`tickExit(ctx)`를 실행한 뒤 `return`**.  
  `checkScalpLight`는 그 아래에만 있으므로 **실행되지 않음**.  
  따라서 ws_lag / daily_loss_limit 여부와 관계없이 **청산 로직은 매 틱 실행**됨.
- **보유 포지션이 없는 경우**: 그때만 `checkScalpLight`로 신규 진입을 막음.

### 결론
| 구분 | 결과 |
|------|------|
| **분류** | **확실히 안전** |
| 근거 | risk gate는 “진입 경로”에만 있고, `activePosition`이 있을 때는 항상 `tickExit()`만 호출 후 return. 기존 보유 포지션의 exit 관리에는 risk gate가 관여하지 않음. |

---

## 2. 경주마 자동 만료 시 상태 정리 완전성

### 확인 항목
- `raceHorseActive`
- `userRequestedRaceHorse`
- `raceHorseManualUntil`
- dashboard / Discord 상태 반영

이 모두 일관되게 정리되는지.

### 코드 (`lib/StrategyManager.js` 151~161행)

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

- StrategyManager 내부: 위 한 블록에서 **세 변수 모두 정리**되고, `refreshProfile()`로 `profile`도 경주마 오버라이드 제거됨.
- `raceHorseExpiryLogged`: 로그 1회만 남기기 위한 플래그이며, UI/상태 노출용이 아님. 만료 후에도 true로 두는 것은 의도된 동작.

### server 쪽 동기화 (`server.js` 911~914, 1427)

```javascript
function updateRaceHorseState() {
  StrategyManager.updateRaceHorseFromSchedule();  // 만료 시 위 블록 실행
  state.raceHorseActive = StrategyManager.isRaceHorseActive();
}
// runOneTick() 맨 앞(1427행)에서 updateRaceHorseState() 호출
```

- 매 틱마다 `updateRaceHorseFromSchedule()` → 필요 시 만료 처리 후, `state.raceHorseActive = isRaceHorseActive()`로 갱신.
- Dashboard/Discord는 모두 **`state.raceHorseActive`** 또는 **`getRaceHorseStatusLabel(state.raceHorseActive)`**만 사용 (1354, 1363, 1701, 2081, 2090, 2147, 2231 등).  
  즉, StrategyManager에서 만료로 OFF 되면 **같은 틱 또는 다음 틱부터** 화면/디스코드에 비활성으로 반영됨.

### 결론
| 구분 | 결과 |
|------|------|
| **분류** | **확실히 안전** |
| 근거 | 만료 시 raceHorseActive, userRequestedRaceHorse, raceHorseManualUntil가 한 번에 정리되고, server의 state.raceHorseActive는 매 틱 StrategyManager와 동기화되며, dashboard/Discord는 이 state만 참조함. |

---

## 3. 완화 + 경주마 동시 활성화 시 최종 profile 값 (모드 조합별)

### 기준 코드
- `config.default.js`: `DEFAULT_PROFILE`, `RELAXED_OVERRIDES` (entry_score_min: 2, strength_threshold: 0.5), `RACE_HORSE_OVERRIDES` (weight_vol_surge, weight_strength, weight_price_break, kimp_block_pct만 있음).
- `StrategyManager.getProfile()`: `baseProfile` → (relaxed 남은 시간 > 0이면 RELAXED 병합) → (raceHorseActive면 RACE_HORSE 병합).

### 실제 값 정리 (진입·강도·금액·aggressive)

| 항목 | 없음 (base) | 완화만 | 경주마만 | 완화+경주마 |
|------|-------------|--------|----------|-------------|
| **entry_score_min** | 4 | **2** | 4 | **2** |
| **strength_threshold** | 0.55 | **0.5** | 0.55 | **0.5** |
| **금액 비중** (use50PercentOrder) | false | false | 시간대 내 true | 시간대 내 true |
| **금액 계산** | getBuyOrderAmountKrw(isRaceHorseMode: false) | 동일 | isRaceHorseMode: true, 50% 로직 | 동일(경주마) |
| **weight_vol_surge** | 1 | 1 | **3** | **3** |
| **weight_strength** | 1 | 1 | **3** | **3** |
| **weight_price_break** | 1 | 1 | **0.5** | **0.5** |
| **kimp_block_pct** | 3 | 3 | **7** | **7** |
| **aggressive_mode** (profile) | false | false | false | false |
| **getAggressiveSymbols()** | 별도 TTL 목록 | 별도 | 별도 | 별도 |

- 금액 비중: `server.js` 1518행 `use50PercentOrder = state.raceHorseActive && isRaceHorseTimeWindow` — 경주마 활성 + 시간대일 때만 50% 적용. 완화는 이 값에 관여하지 않음.
- aggressive: `profile.aggressive_mode`는 config 기본값만 사용하며, 완화/경주마 오버라이드에는 없음. `getAggressiveSymbols()`는 별도 TTL 관리로 프로필 모드와 독립.

### 결론
| 구분 | 결과 |
|------|------|
| **분류** | **확실히 안전** (참고용 표 제공) |
| 요약 | 완화+경주마 동시 시: entry_score_min=2, strength_threshold=0.5(완화) + 경주마 가중치/kimp 적용. 금액·aggressive는 위 표와 같이 모드별로 명확히 구분됨. |

---

## 4. scalp cooldown 공유가 메인 엔진 거래를 과도하게 막는지

### 확인 사항
- SCALP 진입 후 MAIN이 **같은 심볼에 몇 분 동안** 진입 불가인지.
- 그 정책이 **코드상 의도된 것**인지.
- **분리 cooldown**이 필요한지 평가.

### 코드
- `lib/risk/riskGate.js`: `duplicate_cooldown_minutes: 30`, `isInCooldown(symbol, lastEntryBySymbol, cooldownMinutes)`.
- `lib/strategy/orchestrator.js`: `recordEntry(symbol, strategy)` → `lastEntryBySymbol[symbol] = now`; 주석 "초 scalp 경량 risk gate용 — 동일 심볼 cooldown 공유".
- `scalpRunner.js`: 매수 체결 시 `ctx.recordEntryForCooldown(symbol)` → server에서 `orchestrator.recordEntry(symbol, 'SCALP')` 호출.
- 메인 진입 시: `orchestrator.tick()` 등에서 `checkAll(ctx, symbol, ...)` 사용 시 `ctx.lastEntryBySymbol`으로 cooldown 검사.

즉, **SCALP가 진입한 심볼도 `lastEntryBySymbol`에 기록**되므로, **MAIN은 동일 심볼에 대해 30분 cooldown** 동안 진입 불가.

### 결론
| 구분 | 결과 |
|------|------|
| **분류** | **주의 필요** |
| 사실 관계 | SCALP 진입 후 **30분** 동안 MAIN이 같은 심볼에 진입 불가. 코드상 “동일 심볼 cooldown 공유”로 **의도된 설계**임. |
| 평가 | 같은 심볼을 SCALP/MAIN이 연달아 치는 것을 막는 목적에는 부합. 다만 30분이 과도하다고 판단되면, (1) cooldown 시간 단축, (2) SCALP 전용 `lastEntryBySymbol`과 MAIN 전용을 분리해 “SCALP 진입 → MAIN만 30분 막기”를 완화하는 방안 검토 가능. |

---

## 5. [SCALP_RISK] 구조화 로그가 반복 flood 될 가능성

### 확인 사항
- ws_lag / daily_loss_limit이 **지속**될 때 **틱마다** 로그가 남는지.
- throttling 없으면 **주의 필요**로 분류.

### 코드 (`lib/scalp_independent/scalpRunner.js` 91~98, 141~146)

- **전역**: `!globalVerdict.allowed`일 때마다 `logLine('[SCALP_RISK] ' + JSON.stringify(...))` 후 `return`.  
  **틱마다** 한 번 호출 가능 (보유 포지션 없을 때만 해당 경로 진입).
- **심볼별**: 루프 안에서 `!scalpLightVerdict.allowed`일 때마다 동일 형식으로 `logLine('[SCALP_RISK] ...')` 후 `continue`.  
  **마켓 수만큼** 같은 틱 내에서 반복 가능.

throttling/디바운스 코드 없음.

### 결론
| 구분 | 결과 |
|------|------|
| **분류** | **주의 필요** |
| 근거 | ws_lag 또는 daily_loss_limit이 계속 걸려 있으면, **진입이 막리는 매 틱마다** 전역 1회 + (진입 시도 마켓당) 심볼별 1회씩 [SCALP_RISK] 로그가 남을 수 있음. throttling이 없어 **반복 flood 가능성** 있음. |
| 권장 | 동일 reason(예: ws_lag, daily_loss_limit)에 대해 “최근 N초에 이미 1회 로그했으면 스킵” 같은 **throttling** 추가 권장. |

---

## 요약 표 (안전/주의/위험)

| # | 항목 | 분류 | 요약 |
|---|------|------|------|
| 1 | 초 scalp risk gate가 exit까지 막는지 | **확실히 안전** | 보유 포지션 있으면 매 틱 `tickExit()`만 실행하고, risk gate는 신규 진입 경로에만 있어 청산 로직은 항상 동작. |
| 2 | 경주마 자동 만료 시 상태 정리 | **확실히 안전** | raceHorseActive, userRequestedRaceHorse, raceHorseManualUntil 정리되고, state.raceHorseActive 및 dashboard/Discord는 이 state만 사용해 일관됨. |
| 3 | 완화+경주마 동시 시 최종 profile 값 | **확실히 안전** | 모드 조합별 entry_score_min, strength_threshold, 금액 비중, aggressive 관련 값을 표로 정리함. |
| 4 | scalp cooldown 공유로 메인 과도 차단 | **주의 필요** | SCALP 진입 후 30분간 MAIN 동일 심볼 진입 불가는 의도된 설계이나, 정책상 30분이 길면 시간 단축 또는 SCALP/MAIN cooldown 분리 검토. |
| 5 | [SCALP_RISK] 로그 반복 flood | **주의 필요** | throttling 없어 ws_lag/daily_loss_limit 지속 시 틱마다(및 마켓마다) 로그 가능. 동일 사유 throttling 추가 권장. |

**위험**으로 분류된 항목은 없음.
