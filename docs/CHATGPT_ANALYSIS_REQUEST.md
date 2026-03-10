# ChatGPT 분석 요청용 문서

아래 내용을 **그대로 복사해 ChatGPT에 붙여 넣고**, 마지막의 「분석 요청」 지시를 함께 전달하면 됩니다.

---

## 1. 프로젝트 개요

- **Node.js 기반 업비트(Upbit) 자동매매 대시보드** (Express + Socket.IO + Discord 봇)
- **매매 엔진**: 메인 오케스트레이터(SCALP/REGIME) + 독립 초단타 스캘프 봇(independent scalp)
- **로그 위치**: 프로젝트 루트 `dashboard/` 기준 `logs/` 폴더

### 주요 로그 파일

| 로그 파일 | 설명 |
|-----------|------|
| `logs/pm2-upbit-bot-out.log` | 대시보드·매매 엔진·Discord 봇 표준 출력 |
| `logs/pm2-upbit-bot-error.log` | 동일 프로세스 표준 에러 |
| `logs/independent_scalp.log` | 독립 스캘프 봇 전용 (진입/청산, SCALP_ENTRY, SCALP_EXIT_TP/SL 등) |
| `logs/google_trends_error.log` | Google Trends 데이터 수집 실패·경고 (invalid_json, request_error 등) |
| `logs/trade.log` | 매매/체결 관련 로그 (로테이션) |
| `logs/gemini-error-diagnostic.log` | Gemini API 오류 시 진단 로그 |

### 관련 코드 경로

- **Google Trends**: `dashboard/lib/meme/googleTrends.js` — `fetchTrendSpike()`, `writeTrendsError()`, 응답 검사·JSON 파싱
- **독립 스캘프 (주문 수량·진입)**: `dashboard/lib/scalp_independent/scalpRunner.js` — `placeMarketBuyByPrice` 호출, `volume` 추출, `SCALP_ENTRY` 로그(약 225행), PnL/기록 로직

### 로그 샘플 (3~5줄, ChatGPT 분석용)

**google_trends_error.log**
```
[2025-03-10T12:00:01.234Z] [DATA_SOURCE_WARN] source=google_trends reason=invalid_json {"symbol":"BTC","preview":"<!DOCTYPE html><html..."}
[2025-03-10T12:00:02.345Z] [DATA_SOURCE_WARN] source=google_trends reason=request_error {"symbol":"ETH","message":"429 Too Many Requests"}
[2025-03-10T12:00:03.456Z] [DATA_SOURCE_WARN] source=google_trends reason=parse_error {"symbol":"SOL","error":"Unexpected token < in JSON"}
```

**independent_scalp.log**
```
[2025-03-10T09:05:11.111Z] [SCALP_DECISION] symbol=BTC chosen=SCALP score=0.72 action=ENTRY
[2025-03-10T09:05:12.222Z] [SCALP_ENTRY] symbol=BTC side=BUY price=103500000 qty=0 mode=TAKER
[2025-03-10T09:05:45.333Z] [SCALP_EXIT_TP] symbol=BTC pnl=+8xxxx.xx% duration_sec=34
[2025-03-10T09:06:01.444Z] [SCALP_ENTRY] symbol=ETH side=BUY price=5200000 qty=0.001 mode=TAKER
[2025-03-10T09:06:02.555Z] [SCALP_ENTRY_ERR] symbol=BTC err=INSUFFICIENT_FUNDS_BID
```

**pm2-upbit-bot-error.log (참고)**
```
Error: 429 Too Many Requests
    at ...
[DATA_SOURCE_WARN] source=google_trends reason=request_error ...
```

---

## 2. Gemini 2.5 Flash 분석 결과 (하루치 로그·일 단위)

오늘자 로그를 기준으로 한 **하루치 로그(일 단위) 분석** 결과입니다.

> **하루치 로그 (일 단위) 분석 오늘자 로그에서 두 가지 주요 오류가 발견되었습니다.**
>
> 1. **Google Trends 데이터 수집 오류**
>    * **파일/모듈:** `google_trends_error.log` (Google Trends 데이터 소스)
>    * **원인 추정:** Google Trends API에 과도한 요청을 보내 `429 Too Many Requests` 응답을 받고 있으며, 이를 잘못 JSON으로 파싱하려 시도하여 `invalid_json` 경고가 발생합니다.
>    * **수정 제안:** Google Trends 데이터 요청 시 해당 모듈에 지수 백오프 또는 지연을 포함한 요청 속도 제한(rate-limiting) 로직을 추가하고, HTTP 응답 코드 확인 후 JSON 파싱을 시도하도록 예외 처리를 강화해야 합니다.
>
> 2. **제로 수량 거래 및 PnL 불일치**
>    * **파일/모듈:** `independent_scalp.log` (주문 수량 결정 및 PnL 계산 로직)
>    * **원인 추정:** `SCALP_ENTRY` 로그에 `qty=0`인 거래 시도가 반복적으로 관찰됩니다. 이는 실제 거래 수량이 0임을 의미하며, 이로 인해 로그에는 비현실적인 높은 PnL(예: +8xxxx.xx%)이 기록되지만, 실제 DB 요약에서는 PnL 0 및 승률 0.0%로 집계되어 주문 수량 계산 또는 0 수량 주문 처리에 문제가 있는 것으로 판단됩니다.
>    * **수정 제안:** `independent_scalp` 모듈 내 주문 수량(qty)을 결정하는 로직을 검토하여 항상 유효하고 0보다 큰 수량이 생성되도록 수정하고, 주문 실행 전 `qty > 0` 유효성 검사를 추가하여 0 수량의 주문을 방지해야 합니다.

---

## 3. Gemini 2.5 Flash 분석 결과 (조언자의 한마디)

최근 거래(KRW-BTC 등)를 바탕으로 한 **조언자의 한마디** 요약입니다.

> **1) 성공/실패의 핵심 원인 기술적 분석**
>
> 제공된 거래 데이터는 스캘핑 전략의 전형적인 빠른 진입과 청산을 보여주고 있습니다. 모든 거래가 "sell"로 기록되어 있어 이전에 매수했던 포지션을 청산한 것으로 보입니다.
>
> * **성공 원인 (첫 번째 거래):** 첫 번째 거래(`price`: 103,528,000, `net_return`: 0.0009659315927246033)는 명확하게 양(+)의 순수익을 기록했습니다. 이는 해당 포지션의 진입 가격이 청산 가격보다 낮았으며, 짧은 시간 내에 적절한 상승 모멘텀을 포착하여 성공적으로 익절(강제 익절, Score-out)을 실행했음을 의미합니다.
>
> * **실패/중립 원인 (두 번째 및 세 번째 거래):** 이후 두 거래(`price`: 103,565,000, `net_return`: 0)는 동일한 가격에 청산되었음에도 순수익이 0으로 기록되었습니다. 진입 타점의 미흡, 부족한 가격 모멘텀, 수수료 상쇄 실패, '강제 익절(Score-out)'이 본전 청산에 그쳤을 가능성 등이 지적되었습니다.
>
> **2) 다음 매매에서 주의해야 할 한 가지 조언**
>
> **조언:** '강제 익절'이 단순한 본전 청산이 아닌 실제 수익으로 이어질 수 있도록, 진입 시점에 거래 수수료를 상쇄하고도 충분한 가격 상승 모멘텀을 확보할 수 있는 진입 타점을 더욱 정교하게 분석하십시오.

---

## 4. 코드 상 참고 사항 (현재 구현)

- **Google Trends** (`lib/meme/googleTrends.js`): `google-trends-api` 패키지 사용, 10분 캐시, 심볼 간 800ms 지연(`DELAY_BETWEEN_SYMBOLS_MS`). 응답이 JSON 형태가 아니면 `invalid_json`으로 로그 후 fallback 1. **429 처리·지수 백오프·HTTP 상태 코드 분기**는 현재 없음.
- **독립 스캘프** (`lib/scalp_independent/scalpRunner.js`): `placeMarketBuyByPrice(..., Math.round(amountKrw), orderableKrw)` 호출 후 `order.executed_volume` 또는 `order.volume`을 `volume`으로 사용. **volume이 0이어도** 그대로 `activePosition.volume`, `SCALP_ENTRY`의 `qty`, `recordTrade`의 `quantity`에 반영됨. **주문 전 `amountKrw`/수량 검증**은 있으나, **API 반환 volume이 0인 경우 차단·재시도·로깅 보정** 로직은 없음.

### 4.1 코드 스니펫 (문제 구간 — ChatGPT patch 제안용)

**googleTrends.js (문제 구간)**  
파일: `dashboard/lib/meme/googleTrends.js`, 함수: `fetchTrendSpike(symbol)`

```javascript
const res = await Promise.race([
  googleTrends.interestOverTime({ keyword, startTime: new Date(Date.now() - 32 * 24 * 60 * 60 * 1000) }),
  new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 15000))
]);
const resStr = typeof res === 'string' ? res : (res != null ? String(res) : '');
if (!isLikelyJson(resStr)) {
  // 429 응답 등 HTML/비JSON 도 여기로 옴 → invalid_json 로그
  logger.dataSourceWarn(`source=google_trends reason=invalid_json symbol=${symbol}`);
  writeTrendsError('[DATA_SOURCE_WARN] source=google_trends reason=invalid_json', { symbol, preview: resStr.slice(0, 200) });
  // ...
}
// ...
const parsed = typeof res === 'string' ? JSON.parse(res) : res;  // parse_error 가능
```

- **요약**: 429/HTML 응답을 JSON으로 파싱하려다 `invalid_json`·`parse_error` 발생. HTTP 상태 코드 확인·429 시 백오프 없음.

**scalpRunner.js (문제 구간)**  
파일: `dashboard/lib/scalp_independent/scalpRunner.js`, 진입 블록

```javascript
let amountKrw = totalAssets > 0 ? Math.floor(totalAssets * 0.5) : 0;
amountKrw = Math.min(orderableKrw, amountKrw);
amountKrw = Math.max(MIN_ORDER_KRW, amountKrw);
if (amountKrw * (1 + UPBIT_FEE_RATE) > orderableKrw && orderableKrw > 0) {
  amountKrw = Math.floor(orderableKrw / (1 + UPBIT_FEE_RATE));
}
if (amountKrw < MIN_ORDER_KRW) {
  logLine(`[SCALP_SKIP] symbol=${symbol} insufficient_funds ...`);
  continue;
}
// ...
const order = await TradeExecutor.placeMarketBuyByPrice(apiKeys.accessKey, apiKeys.secretKey, market, Math.round(amountKrw), orderableKrw);
const volume = order && (order.executed_volume != null ? order.executed_volume : order.volume);
scalpState.activePosition = { ..., volume };
logLine(`[SCALP_ENTRY] symbol=${symbol} side=BUY price=${...} qty=${volume} mode=TAKER`);
```

- **요약**: API가 `volume === 0`을 반환해도 그대로 포지션·로그에 넣어 `qty=0` 및 PnL 왜곡 가능. 주문 전 `amountKrw < MIN_ORDER_KRW` 재확인 없음.

### 4.2 amountKrw가 5000원 이하로 떨어질 가능성 (qty=0과의 관계)

- **업비트 최소 주문 금액**: 5,000 KRW. 이보다 작은 금액으로는 주문이 체결되지 않아 **실질적으로 qty=0**이 될 수 있음.
- **현재 코드**:
  - `amountKrw = Math.max(MIN_ORDER_KRW, amountKrw);` 로 한 번 5000 이상으로 올린 뒤,
  - 수수료 반영으로 `amountKrw = Math.floor(orderableKrw / (1 + UPBIT_FEE_RATE));` 를 적용하면 **orderableKrw가 5000 근처일 때 amountKrw가 5000 미만으로 내려갈 수 있음** (예: orderableKrw 5000 → 약 4997).
  - 그 직후 `if (amountKrw < MIN_ORDER_KRW) { ... continue; }` 로 **진입 자체는 스킵**하므로, **이 파일만 보면 `placeMarketBuyByPrice`에는 5000 미만이 넘어가지 않도록 되어 있음**.
- **그럼에도 qty=0이 나오는 경우**: (1) 거래소/API가 최소 금액 미달·일시 오류 등으로 0 수량을 반환, (2) 다른 경로에서 amountKrw가 5000 미만으로 계산되는 엣지 케이스가 있을 수 있음.
- **권장**: **qty=0 차단만이 아니라, `placeMarketBuyByPrice` 호출 직전에 `amountKrw < MIN_ORDER_KRW` 를 한 번 더 검사해 차단하는 것**이 더 근본적. 그다음으로 API 반환 `volume`이 0 이하일 때는 주문 성공으로 간주하지 않고 로그/알림만 남기는 처리를 추가하는 것이 좋음.

---

## 5. ChatGPT에게 요청할 분석 지시 (복사용)

아래 블록을 **그대로 복사해 ChatGPT 입력란에 붙여 넣고**, 필요하면 앞에 「위 문서 전체를 참고해서」 같은 문장을 붙여 사용하세요.

```
위 문서는 Node.js 업비트 자동매매 대시보드의 로그 구조·로그 샘플·문제 구간 코드 스니펫과, Gemini 2.5 Flash로 수행한 "하루치 로그(일 단위) 분석" 및 "조언자의 한마디" 결과를 정리한 내용이다.

다음 작업을 요청한다.

1. **수정 우선순위**: Gemini가 지적한 두 가지(Google Trends 429/invalid_json, independent scalp qty=0·PnL 불일치)에 대해, 운영 영향도와 구현 난이도를 고려해 우선순위를 정하고, 각 항목을 1~2문장으로 요약해 달라.

2. **구체적 코드 수정안 (문서의 로그 샘플·4.1 코드 스니펫을 참고해 가능하면 구체적 patch 형태로)**  
   - Google Trends: 429 발생 시 지수 백오프·재시도 대기·요청 간 지연 강화, 그리고 HTTP 응답 코드(또는 응답 형태) 확인 후에만 JSON 파싱 시도하도록 수정 제안. 파일·함수·가능하면 라인 근처를 명시.  
   - Independent scalp: (1) **업비트 최소 주문 5000 KRW**이므로, qty=0의 상당수가 amountKrw < 5000에서 발생할 수 있음. 따라서 **amountKrw < MIN_ORDER_KRW 인 경우를 placeMarketBuyByPrice 호출 직전에 한 번 더 검사해 차단하는 것**을 qty=0 대응보다 먼저 적용할 것을 권장. (2) 그 다음으로, API 반환 volume이 0 이하인 경우 주문 성공으로 간주하지 않고 로그/알림만 남기고, SCALP_ENTRY에 qty=0이 기록되지 않도록(또는 0이면 명시적 경고 로그) 처리 제안. 문서 4.1의 코드 스니펫을 기준으로 파일·함수·라인 근처를 명시해 patch 형태로 제안해 달라.

3. **추가 검증 포인트**: 위 수정을 적용한 뒤, 로그와 DB로 확인하면 좋은 검증 포인트 3가지를 짧게 나열해 달라.

4. **조언자 요약 반영**: "조언자의 한마디"에서 제안한 진입 타점·수수료 상쇄·강제 익절 개선을, 코드/설정 변경 관점에서 1~2가지 구체적 아이디어로 정리해 달라.
```

---

*이 문서는 `dashboard/docs/CHATGPT_ANALYSIS_REQUEST.md` 에 있으며, 로그 구조나 Gemini 응답이 바뀌면 해당 섹션만 갱신하면 됩니다.*
