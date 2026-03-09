# 학습용 리포트: 설계 대비 실제 구현 분석

ARCHITECTURE_AND_DATA_FLOW.md의 설계가 소스 코드에서 어떻게 구현되어 있는지, 다음 네 가지 질문에 맞춰 **함수명·파일 경로를 인용**하여 정리한 문서입니다.

---

## 1. 데이터의 여행: 시세 → 점수 → 게이지

**질문**: upbitWs.js에서 시세가 들어온 순간부터 scalpEngine.js에서 점수가 계산되고, 최종적으로 index.html의 게이지가 움직이기까지의 과정을 코드상 함수명으로 설명해 달라.

### 1.1 시세 유입 (upbitWs.js)

- **함수**: `subscribeTicker(codes, onMessage, onError)` (lib/upbitWs.js)
- **동작**: WebSocket `ws.on('message', ...)`에서 수신한 JSON을 파싱한 뒤, `item.trade_price`, `item.code`(또는 `item.market`)가 있으면 **콜백 `onMessage(...)`를 한 번 호출**합니다.
- **전달 인자**: `{ market, tradePrice, signedChangeRate, timestamp, wsLagMs }`.  
  `wsLagMs`는 `Math.max(0, Date.now() - ts)`로 계산됩니다 (서버 타임스탬프 기준 지연).

즉, “시세가 들어온 순간”은 **`onMessage` 콜백이 호출되는 시점**입니다.

### 1.2 server.js에서의 수신과 상태 반영

- **등록 코드** (server.js):
  ```js
  upbitWs.subscribeTicker(SCALP_MARKETS, (tick) => {
    state.prices[tick.market] = tick;
    if (tick.wsLagMs != null) state.wsLagMs = tick.wsLagMs;
    pushPrice(tick.market, tick.tradePrice);
    emitDashboard().catch((e) => console.error('emitDashboard:', e.message));
  }, ...);
  ```
- **함수 역할**:
  - `state.prices[tick.market] = tick` → 전역 state에 해당 마켓 시세 저장.
  - `pushPrice(market, tradePrice)` → `priceHistory[market]` 배열에 가격을 넣고, 최대 60개만 유지 (`PREV_HIGH_WINDOW`). 나중에 `getPrevHigh(market)`에서 사용.
  - `emitDashboard()` → `state.lastEmit`을 채운 뒤 `io.emit('dashboard', state.lastEmit)` 호출.

따라서 **틱이 올 때마다** 한 번씩 `emitDashboard()`가 불리므로, 시세만 바뀌어도 프론트에는 그 시점의 `state`(가격·과거 스캘프 상태 등)가 전달됩니다.

### 1.3 1초 주기에서 스냅샷·점수 계산 (server.js ↔ scalpEngine.js)

- **주기 실행** (server.js): `setInterval(..., ASSET_POLL_MS)` (1초) 안에서  
  `state.trades = await db.getRecentTrades(10)`, `computeKimp()`, **`await runScalpCycle()`**, 그 다음 `emitDashboard()`가 실행됩니다.

- **`runScalpCycle()`** (server.js) 내부 흐름:
  1. `upbit.getTickers(SCALP_MARKETS)`, `upbit.getOrderbook(SCALP_MARKETS)` 로 REST로 시세·호가 조회.
  2. 마켓별로:
     - `buildSnapshotFromOrderbook(obMap[market], ticker, market)`  
       → 호가·스프레드·깊이·strength·obi·**kimp_pct** 등을 넣은 스냅샷 객체 생성.  
       `kimp_pct`는 `state.kimpByMarket[market]`에서 가져옵니다.
     - `currentPrice = state.prices[market]?.tradePrice ?? ticker?.trade_price`  
       → 실시간 틱이 있으면 그 가격, 없으면 REST ticker 사용.
     - `pushPrice(market, currentPrice)` → 가격 히스토리 갱신.
     - `getPrevHigh(market)` → `priceHistory[market]`에서 최근 60개 중 최댓값 반환.
     - **`scalpEngine.runEntryPipeline(snapshot, prevHigh, currentPrice, market)`** 호출.
  3. `runEntryPipeline` 반환값으로 `nextScalpState[market]` 설정:
     - `entryScore: pipeline.score`
     - `p0GateStatus: pipeline.p0Allowed ? null : pipeline.p0Reason`
     - `strength_proxy_60s: strength`
  4. `state.scalpState = nextScalpState` 로 전역 상태 갱신.

- **`runEntryPipeline`** (lib/scalpEngine.js):
  - `checkEntryGates(snapshot)` → P0 통과 여부 및 차단 사유.
  - `getVolSurge(snapshot)` → 볼륨 서지 여부.
  - `prevHigh`, `currentPrice`, `tickSize`로 price break 여부 계산.
  - `entryScore(snapshot, priceBreak, volSurge)` → 0~7 점수.
  - `{ p0Allowed, p0Reason, volSurge, priceBreak, score }` 반환.

즉, **점수가 계산되는 곳**은 `scalpEngine.entryScore`이고, 그 입력은 `runEntryPipeline`이 스냅샷·prevHigh·currentPrice를 이용해 만든 결과입니다.

### 1.4 프론트로 전달되고 게이지가 움직이는 과정

- **전송**: `emitDashboard()`에서 `state.lastEmit`에 `scalpState: state.scalpState`를 넣고 `io.emit('dashboard', state.lastEmit)`를 호출합니다.  
  같은 `state.lastEmit`은 1초마다 도는 `setInterval` 안에서도 갱신된 `state.scalpState`로 덮어쓴 뒤 다시 `io.emit('dashboard', ...)` 되므로, **최신 점수·P0 상태는 최대 1초 주기**로 클라이언트에 전달됩니다.

- **수신** (public/js/app.js):
  - `socket.on('dashboard', function (data) { ... })` 에서 `data.scalpState`를 받습니다.
  - `if (data.scalpState) renderScalpState(data.scalpState);` 로 **`renderScalpState(scalpState)`** 가 호출됩니다.

- **`renderScalpState(scalpState)`** (app.js):
  - `['BTC','ETH','XRP','SOL']` 에 대해 `scalpState['KRW-'+sym]` 를 읽습니다.
  - `s.entryScore` → 0~7 점수를 `scorePct = (score/7)*100` 으로 퍼센트화한 뒤,  
    `style="width: ... %"` 인 게이지 바 div를 채웁니다.
  - `s.p0GateStatus` → `'OK'` 이면 초록, 아니면 노란 뱃지로 **`P0: ` + p0** 문자열을 표시합니다 (예: `P0: BLOCK_KIMP`).
  - `s.strength_proxy_60s` → 0~100% 로 변환해 Strength 바 너비로 사용합니다.

정리하면, **데이터의 여행**은 다음과 같이 한 줄로 이어집니다.

- **upbitWs.js** `subscribeTicker` → (메시지 수신 시) **onMessage(tick)**  
  → **server.js**: `state.prices[tick.market]=tick`, **pushPrice(market, tradePrice)**, **emitDashboard()**
- 1초마다 **runScalpCycle()** → **buildSnapshotFromOrderbook()** → **getPrevHigh(market)** → **scalpEngine.runEntryPipeline()** → 내부에서 **checkEntryGates()**, **getVolSurge()**, **entryScore()** → **state.scalpState** 갱신 → **emitDashboard()** → **io.emit('dashboard', state.lastEmit)**
- **app.js**: **socket.on('dashboard', …)** → **renderScalpState(data.scalpState)** → index.html의 코인 카드 안 **게이지 바·P0 뱃지** DOM 갱신.

---

## 2. P0 게이트와 김프 방어: checkEntryGates와 “뱃지만” 전달

**질문**: checkEntryGates가 김치 프리미엄 3% 차단을 어떻게 수행하는지, 그리고 그 결과가 로그창이 아니라 카드의 뱃지로만 전달되는 통로를 짚어 달라.

### 2.1 김프 3% 차단 로직 (checkEntryGates)

- **위치**: lib/scalpEngine.js, 함수 **`checkEntryGates(snapshot)`**.
- **김프 판단** (문서와 동일한 조건):
  ```js
  if (snapshot.kimp_pct != null && snapshot.kimp_pct > 3) {
    return { allowed: false, reason: 'BLOCK_KIMP' };
  }
  ```
  즉, 스냅샷에 **김프 퍼센트(`kimp_pct`)가 있고 3 초과**이면 진입 금지, 사유는 **`BLOCK_KIMP`**입니다.  
  (명세의 “3%를 넘으면”을 **초과**로 구현한 상태입니다.)

- **`kimp_pct`가 스냅샷에 들어가는 경로** (server.js):
  - **computeKimp()**에서 `state.kimpByMarket[market]`를 채웁니다.  
    공식: `(업비트가격 / (바이낸스USD × 환율) - 1) * 100`.
  - **buildSnapshotFromOrderbook(orderbookItem, ticker, market)** 에서  
    `kimpPct = state.kimpByMarket[market] ?? null` 로 읽어  
    반환 객체에 **`kimp_pct: kimpPct`** 로 넣습니다.
  - 따라서 **runEntryPipeline(snapshot, ...)** 에 넘어가는 `snapshot`에는 이미 김프 값이 들어 있고, **checkEntryGates(snapshot)** 가 그걸 보고 3% 초과 시 `BLOCK_KIMP`를 반환합니다.

### 2.2 결과가 “로그창이 아닌 카드 뱃지”로만 가는 통로

- **runScalpCycle()** (server.js)에서는:
  - **P0 차단 시(즉 `!pipeline.p0Allowed`)** 에는 **어떤 로그도 남기지 않습니다.**  
    `tradeLogger.logTag('BLOCK_KIMP', ...)` 또는 `tradeLogger.logTag('BLOCKED', ...)` 호출이 **없습니다.**
  - **로그는** `pipeline.p0Allowed && pipeline.score >= profile.entry_score_min` 일 때만  
    **`tradeLogger.logTag('BUY_SIGNAL', ...)`** 한 번 호출됩니다.

- **P0 결과는** 오직 **상태 객체**로만 전달됩니다:
  - `nextScalpState[market] = { entryScore: pipeline.score, p0GateStatus: pipeline.p0Allowed ? null : pipeline.p0Reason, strength_proxy_60s: strength }`
  - `state.scalpState = nextScalpState` → `emitDashboard()`에서 `state.lastEmit.scalpState = state.scalpState` → **io.emit('dashboard', state.lastEmit)**.

- **프론트** (app.js):
  - **renderScalpState(data.scalpState)** 가 `s.p0GateStatus`를 읽어  
    `p0 === 'OK'` 이면 초록, 아니면 노란색 뱃지로 **`P0: ` + p0** (예: `P0: BLOCK_KIMP`)를 **해당 코인 카드 안의 한 개 뱃지 요소**에만 넣습니다.  
  - 로그창은 **renderLogs(data.logs)** 로만 갱신되고, P0 차단 시에는 새 로그 라인이 추가되지 않으므로 **로그창에는 BLOCK_KIMP가 안 뜨고, 카드의 뱃지에만 BLOCK_KIMP가 표시**됩니다.

요약하면:

- **김프 3% 차단**: **checkEntryGates(snapshot)** 에서 **snapshot.kimp_pct > 3** 일 때 **reason: 'BLOCK_KIMP'** 반환.
- **통로**: runScalpCycle이 **로그는 찍지 않고** **nextScalpState[market].p0GateStatus = pipeline.p0Reason** 만 설정 → **state.scalpState** → **emitDashboard** → **Socket 'dashboard'** → **renderScalpState** → **코인 카드의 P0 뱃지 DOM**만 갱신.

---

## 3. DB의 효율적 관리: cleanupOldNonTrades와 4시간 주기

**질문**: db.js의 cleanupOldNonTrades가 4시간마다 실행되는 메커니즘과, 왜 BUY/SELL은 남기고 다른 로그만 지우는지, SQL 쿼리의 의미를 설명해 달라.

### 3.1 4시간마다 실행되는 메커니즘

- **위치**: server.js.
  - **주기 실행**:
    - `setInterval(runDbCleanup, CLEANUP_INTERVAL_MS)`  
      `CLEANUP_INTERVAL_MS = 4 * 60 * 60 * 1000` (4시간).
    - **최초 1회**: `setTimeout(runDbCleanup, 60 * 1000)` → 기동 후 1분 뒤 한 번 실행.
  - **runDbCleanup()**:
    - `db.cleanupOldNonTrades(4).then((deleted) => { ... })`  
      → **cleanupOldNonTrades(cutoffHours = 4)** 를 호출하고, 삭제 건수가 0보다 크면 콘솔에만 로그를 남깁니다 (대시보드 로그창에는 넣지 않음).

즉, **4시간마다** + **서버 기동 1분 후 1회** **cleanupOldNonTrades(4)** 가 실행됩니다.

### 3.2 cleanupOldNonTrades의 SQL과 “BUY/SELL만 남긴다”는 의미

- **위치**: lib/db.js, 함수 **cleanupOldNonTrades(cutoffHours = 4)**.

- **cutoff 시점**:
  - `cutoff = new Date(Date.now() - cutoffHours * 3600 * 1000).toISOString()`  
    → “현재 시각 − 4시간” 이전 시각을 ISO 문자열로 둡니다.

- **실행 쿼리** (의미 단위로 나누면):
  ```sql
  DELETE FROM trades
  WHERE timestamp < ?
    AND (
      side IS NULL
      OR TRIM(COALESCE(side, '')) = ''
      OR LOWER(TRIM(side)) NOT IN ('buy', 'sell')
    )
  ```
  - **`timestamp < ?`**  
    → 4시간보다 오래된 행만 대상. 최근 4시간 데이터는 건드리지 않습니다.
  - **AND (...)**  
    → “실제 체결 거래가 아닌 행”만 삭제하기 위한 조건입니다.
    - `side IS NULL` → side가 없으면 “거래”로 보지 않고 삭제.
    - `TRIM(COALESCE(side,'')) = ''` → 빈 문자열(공백만 있던 것 포함)도 비거래로 보고 삭제.
    - **`LOWER(TRIM(side)) NOT IN ('buy', 'sell')`**  
      → 소문자로 정규화했을 때 **`'buy'`도 `'sell'`도 아닌** 행만 삭제.  
      즉 **`side`가 `'buy'` 또는 `'sell'`인 행은 이 조건에 걸리지 않아 DELETE 대상에서 제외**됩니다.

- **의도**:
  - **trades** 테이블에는 “실제 매수/매도 체결”만 **영구 보존**해 통계·리포트에 씁니다.
  - 설계상 “단순 판단 기록”이나 “진입 차단 로그” 같은 것은 side가 NONE이거나 비어 있거나, 다른 값으로 들어갈 수 있게 두었을 때, 이런 행들은 4시간이 지나면 **cleanupOldNonTrades**로 지워서 DB 크기를 관리합니다.
  - 따라서 **“BUY/SELL은 남기고, 그 외 로그만 지운다”**는 것은, **WHERE 절에서 side가 'buy' 또는 'sell'인 행은 제외**함으로써 구현됩니다.

---

## 4. 페이지 간 역할 분담: API 호출과 index만 Socket을 쓰는 이유

**질문**: index.html, meme.html, stats.html이 각각 서버의 어떤 API(endpoint)를 호출해 데이터를 가져오는지, 왜 index만 Socket.io를 쓰는지 분석해 달라.

### 4.1 페이지별 API 사용

| 페이지 | 사용 API (endpoint) | 용도 |
|--------|---------------------|------|
| **index.html** (메인 대시보드) | **GET /api/trades** | 초기 로드 시 최근 거래 10건 (거래 내역 영역). |
| | **GET /api/meme/mpi** | MPI 위젯용 (60초 주기 fetch). |
| | **GET /api/check-upbit** | “API 연결 확인” 버튼 클릭 시 Upbit 연동 검사. |
| | **Socket.io** | **'dashboard'** 이벤트로 자산·가격·스캘프 상태·로그·거래·FX·김프·WS Lag 등 **실시간 스트림** 수신. |
| **meme.html** (MPI 상세) | **GET /api/meme/mpi** | MPI 리스트·컴포넌트·히스토리 (10초 주기 fetch). |
| **stats.html** (수익률 통계) | **GET /api/stats** | 승률·MDD·수수료·시간대별/코인별/청산사유/일별 통계 + (서버 state 기반) 환율·자산 USD. 페이지 로드 시 1회. |

- **index**만 **Socket.io**를 쓰고, **meme**과 **stats**는 **REST(HTTP)** 만 사용합니다.

### 4.2 index만 Socket을 쓰는 이유

- **index.html**은 “실시간 HTS” 화면입니다.
  - Upbit 시세가 바뀔 때마다 가격·플래시를 갱신하고,
  - 1초마다 자산·스캘프 점수·P0 뱃지·로그·거래 목록·환율·김프·WS Lag를 다시 그려야 합니다.
  - 이걸 **폴링만**으로 하면 매번 **GET /api/...** 여러 개를 반복 호출해야 하고, 지연·부하가 커집니다.  
  → **한 번 연결한 Socket으로 서버가 1초마다 (또는 틱 시) 묶어서 보내주는 `dashboard` 이벤트**를 받아 한 번에 DOM을 갱신하는 방식이 적합합니다.

- **meme.html**은 “MPI 상세” 페이지로, 10초 단위 갱신이면 충분하고, 필요한 데이터가 **/api/meme/mpi** 하나로 한 번에 옵니다.  
  **stats.html**은 “통계 요약”으로, 들어올 때 한 번 **/api/stats**로 받아서 차트를 그리면 됩니다.  
  둘 다 **짧은 주기 폴링 또는 1회 로드**로 충분하고, 실시간 스트림이 필요하지 않으므로 **Socket을 쓰지 않고 REST만** 사용합니다.

정리하면:

- **index**: 실시간성 필요 → **Socket.io `dashboard`** + 보조로 **/api/trades**, **/api/meme/mpi**, **/api/check-upbit**.
- **meme**: 10초 주기 MPI → **/api/meme/mpi** 만.
- **stats**: 1회 통계 → **/api/stats** 만.

---

## 5. 실제 파일 구조를 반영한 최종 요약도

아래는 **코드베이스의 실제 디렉터리·파일**을 반영한 요약도입니다.  
데이터가 “어디서 생성되고, 어디를 거쳐, 어디서 소비되는지” 한눈에 보이도록 했습니다.

```mermaid
flowchart TB
    subgraph External["외부"]
        UpbitWS["Upbit WebSocket\nwss://api.upbit.com/websocket/v1"]
        UpbitREST["Upbit REST\n/ticker, /orderbook, /accounts"]
        FX["환율 API\nfawazahmed0"]
        Binance["Binance API\n/ticker/price"]
    end

    subgraph lib["lib/"]
        upbitWs["upbitWs.js\nsubscribeTicker()"]
        upbit["upbit.js\ngetTickers, getOrderbook\ngetAccounts, summarizeAccounts"]
        scalp["scalpEngine.js\ncheckEntryGates()\ngetVolSurge()\nentryScore()\nrunEntryPipeline()\nshouldExitScalp()"]
        db["db.js\ninit(), insertTrade()\ngetRecentTrades()\ngetStats()\ncleanupOldNonTrades()"]
        logger["logger.js\nlogTag(), getRecentLogs()"]
    end

    subgraph server["server.js"]
        state["state\nprices, scalpState\nassets, fxUsdKrw\nkimpByMarket, trades\n..."]
        onTick["onMessage(tick)\n→ state.prices, pushPrice\n→ emitDashboard()"]
        loop1s["setInterval 1초\nfetchAssets, fetchFng\ndb.getRecentTrades\ncomputeKimp()\nrunScalpCycle()\nemitDashboard()"]
        runScalp["runScalpCycle()\nbuildSnapshotFromOrderbook()\ngetPrevHigh()\nscalp.runEntryPipeline()\n→ state.scalpState"]
        emit["emitDashboard()\nstate.lastEmit =\n  assets, prices, scalpState\n  trades, logs, fxUsdKrw\n  kimpAvg, wsLagMs\nio.emit('dashboard', ...)"]
        cleanup["runDbCleanup()\ndb.cleanupOldNonTrades(4)\nsetInterval 4h"]
    end

    subgraph public["public/"]
        index["index.html\n+ js/app.js"]
        meme["meme.html"]
        stats["stats.html"]
    end

    UpbitWS --> upbitWs
    upbitWs -->|onMessage(tick)| onTick
    onTick --> state
    onTick --> emit

    UpbitREST --> upbit
    FX --> state
    Binance --> state

    loop1s --> upbit
    loop1s --> db
    loop1s --> runScalp
    runScalp --> scalp
    runScalp --> state
    loop1s --> emit

    state --> emit
    logger --> emit
    db --> state
    emit -->|Socket 'dashboard'| index

    index -->|GET /api/trades| server
    index -->|GET /api/meme/mpi| server
    index -->|GET /api/check-upbit| server
    index -->|emit 'setBot'| server

    meme -->|GET /api/meme/mpi| server
    stats -->|GET /api/stats| server

    cleanup --> db
```

### 5.2 “데이터의 여행” 한 줄 요약 (함수/이벤트 기준)

```
upbitWs.subscribeTicker(..., onMessage)
  → onMessage(tick): state.prices[tick.market]=tick, pushPrice(), emitDashboard()
  → setInterval 1s: runScalpCycle()
    → buildSnapshotFromOrderbook(ob, ticker, market)  // kimp_pct 포함
    → getPrevHigh(market)
    → scalpEngine.runEntryPipeline(snapshot, prevHigh, currentPrice, market)
      → checkEntryGates(snapshot)   // kimp_pct > 3 → BLOCK_KIMP
      → getVolSurge(snapshot)
      → entryScore(snapshot, priceBreak, volSurge)
    → state.scalpState = nextScalpState   // P0 차단 시 로그 없음
  → emitDashboard() → io.emit('dashboard', state.lastEmit)
  → app.js: socket.on('dashboard', data) → renderScalpState(data.scalpState)
    → 코인 카드 #scalp-BTC 등: Entry Score 게이지, P0 뱃지, Strength 바
```

이 문서와 ARCHITECTURE_AND_DATA_FLOW.md를 함께 보면, 설계 문서와 실제 구현이 어떻게 대응하는지 한눈에 파악할 수 있습니다.
