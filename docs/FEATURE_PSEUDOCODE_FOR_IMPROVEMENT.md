# MyScalpBot / MarketSearchEngine — 적용 기능 수도코드 (개선점 검토용)

ChatGPT 등에 붙여넣어 개선점·리팩터링 제안을 받기 위한 문서입니다.  
실제 코드가 아닌 **수도코드(의사코드)** 로 전체 기능을 정리했습니다.

---

## 1. 시스템 개요

```
진입점:
  - server.js     → Express + Socket.IO 대시보드 + 매매 엔진 + MyScalpBot(디스코드 1봇)
  - market_search.js → MarketSearchEngine(디스코드 시황 전용 1봇, 별도 프로세스)

PM2(ecosystem.config.cjs):
  - upbit-bot: server.js (1 인스턴스, autorestart)
  - MarketSearchEngine: market_search.js (1 인스턴스, autorestart)

환경 변수(.env):
  - 매매 봇: DISCORD_TOKEN 또는 DISCORD_BOT_TOKEN, CHANNEL_ID, ADMIN_ID
  - 시황 봇: MARKET_BOT_TOKEN 또는 MARKET_SEARCH_ENGINE_TOKEN, MARKET_SEARCH_ENGINE_CHANNEL_ID
  - 선택: TRADING_LOG_CHANNEL_ID, AI_ANALYSIS_CHANNEL_ID
  - Upbit: UPBIT_ACCESS_KEY, UPBIT_SECRET_KEY
  - Gemini: GEMINI_API_KEY (모델은 코드에서 gemini-2.5-flash 고정, GEMINI_MODEL 미사용)
```

---

## 2. 보안 게이트 (Security Gate)

```
모듈: lib/adminGuard.js
  - normalizeAdminId(envAdminId)        → 앞뒤 공백·따옴표 제거
  - getEffectiveAdminId(envAdminId, backupId) → env 우선, 없으면 backup
  - isAdminUser(userId, effectiveAdminId)     → userId === effectiveAdminId

적용 위치: lib/discordBot.js (MyScalpBot)
  ON 버튼 클릭(interactionCreate):
    IF interaction이 버튼이 아님 THEN return
    userId = interaction.user.id
    IF NOT isAdminUser(userId, effectiveAdminId) THEN
      로그: "[MyScalpBot] Auth Failed — User ID:", userId
      interaction.reply({ content: "주인님 전용 봇입니다. 🔒", ephemeral: true })
      return
    END IF
    (이하 관리자만 실행 가능)
```

- MarketSearchEngine에는 **버튼별 관리자 검사 없음** (시황 채널 버튼은 누구나 조회 가능).

---

## 3. MyScalpBot — 역할 A: 현장 지휘관 (Operator)

```
채널: CHANNEL_ID (제어 패널·알림)
봇 준비 시(ready):
  제어 채널에 다음 메시지 전송:
    - "시스템 재시작 완료"
    - "🎮 역할 A — 현장 지휘관" + buildControlRow() 버튼들
    - "📋 역할 B — 정보 분석가" + buildAnalystRow() 버튼들

버튼 매핑(control):
  [🚀 엔진 가동]  customId: engine_start
  [🛑 즉시 정지] customId: engine_stop
  [📊 현재 상태] customId: current_state
  [📈 현재 수익률] customId: current_return
  [📉 전체 매도]  customId: sell_all
```

### 3.1 엔진 가동 (engine_start)

```
handlers.engineStart():
  IF Upbit API 키 없음 THEN return { success: false, message: "API 키가 설정되지 않았습니다." }
  TRY
    Upbit API 1건 조회(인증 검증)
    state.botEnabled = true
    state.assets = fetchAssets()
    state.initialAssetsForReturn = state.assets.totalEvaluationKrw (있으면)
    emitDashboard()
    return { success: true, message: "자동 매매를 시작합니다." }
  CATCH
    state.botEnabled = false
    IF 401/unauthorized THEN return { success: false, message: "인증 오류(401)..." }
    ELSE return { success: false, message: "연결 실패: " + 에러메시지 }
```

- 디스코드: 버튼 응답으로 위 message 표시 + 성공 시 제어 채널에 같은 문구 1회 전송.

### 3.2 즉시 정지 (engine_stop)

```
handlers.engineStop():
  state.botEnabled = false
  IF API 키 있음 THEN upbit.cancelAllOrders(SCALP_MARKETS) 호출 (미체결 주문 일괄 취소)
  emitDashboard()
```

### 3.3 현재 상태 (current_state)

```
handlers.currentState():
  state.assets = fetchAssets()
  assets = state.assets
  totalEval   = assets.totalEvaluationKrw   // 현재 총자산 (APENFT·PURSE 제외, 아래 참고)
  totalBuy    = assets.totalBuyKrwForCoins  // 총 매수금액
  profitPctNum = (totalBuy > 0) ? ((totalEval - totalBuy) / totalBuy) * 100 : 0
  Embed 구성: 총 평가금액(현재 총자산), KRW 잔고, 총 손익률, 가동 전략, RaceHorse 가중치 테이블
  Footer: "APENFT·PURSE 제외 · 수익률 = ((현재 총자산 - 총 매수금액) / 총 매수금액) × 100"
  RETURN Embed
```

### 3.4 현재 수익률 (current_return)

```
handlers.currentReturn():
  state.assets = fetchAssets()
  totalEval, totalBuyKrw, profitKrw, profitPct 계산 (위와 동일 공식)
  보유 종목 목록: getAccounts() 후 KRW 제외, balance > 0 인 코인만
  Embed: 보유 KRW, 현재 총자산, 총 매수금액, 평가 손익, 가동중인 종목
  Footer: 동일 (APENFT·PURSE 제외 공식)
  RETURN Embed
```

### 3.5 체결 알림 (실시간)

```
호출처: server.js — 매수/매도 체결 시 콜백
  discordBot.sendTradeAlert({ ticker, side, price, quantity, currentReturnPct })

sendTradeAlert(data):
  Embed: 체결 알림 — 매수/매도, 종목, 체결가, 수량, (선택) 현재 수익률
  IF TRADING_LOG_CHANNEL_ID 설정됨 THEN 해당 채널에 전송
  ELSE 제어 채널(CHANNEL_ID)에 전송
```

---

## 4. MyScalpBot — 역할 B: 정보 분석가 (Analyst)

```
버튼 매핑(analyst):
  [💡 AI 자동 분석] customId: analyst_ai_auto
  [📊 시황 요약]     customId: analyst_get_prompt
  [🔍 급등주 분석]   customId: analyst_scan_vol
  [📈 주요지표]     customId: analyst_major_indicators
  [📋 데이터 복사]   customId: ai_analysis
```

### 4.1 AI 자동 분석 (analyst_ai_auto)

```
디스코드:
  즉시 "Gemini AI가 실시간 타점을 분석 중입니다... 🧠" 표시
  handlers.aiAutoAnalysis() 호출 후 결과를 채팅으로 표시 (3문단 이내 텍스트)

handlers.aiAutoAnalysis():
  tickers = upbit.getTopKrwTickersByTradePrice(30)
  top5 = tickers.slice(0, 5)
  FOR EACH t IN top5:
    RSI(14): 5분봉 15개 종가로 계산
    체결강도: 호가 orderbook 매수금액/(매수+매도) * 100
    5분봉 추세: 최근 3봉 기준 상승/하락
    dataLines에 "[SYMBOL] 현재가 ... | RSI ... | 체결강도 ... | 5분봉 추세 ..." 추가
  gemini.askGeminiForScalpPoint(dataLines.join('\n')) 호출
  RETURN Gemini 응답 텍스트 (없으면 안내 문구)
```

### 4.2 분석 데이터 복사 (ai_analysis)

```
handlers.aiAnalysisData():
  (위와 동일하게 상위 5종목 RSI·체결강도·5분봉 수집)
  맨 앞에 "다음 데이터를 분석해서 1% 수익 가능한 스캘핑 타점을 잡아줘:" 추가
  RETURN 전체 텍스트 (디스코드에서 코드블록으로 표시 → 사용자가 ChatGPT 등에 복사)
```

### 4.3 시황 요약 / 급등주 분석 / 주요지표

```
analyst_get_prompt → handlers.analyst.getPrompt()
  FNG, BTC 24h, 상위 10 티커, 김프 등 수집 → gemini.askGeminiForMarketSummary(ctx) → Embed

analyst_scan_vol   → handlers.analyst.scanVol()
  거래대금 상위 10 수집, RSI·체결강도·5분봉 보강 → gemini.askGeminiForScanVol(enriched) → Embed

analyst_major_indicators → handlers.analyst.majorIndicators()
  BTC 도미넌스, F&G 지수, 김프 평균/종목별 → Embed
```

---

## 5. 자산·수익률 계산 (디스코드·웹 동일 공식)

```
모듈: lib/upbit.js — summarizeAccounts(accounts, tickersByMarket)

EXCLUDED_FROM_PNL = ["APENFT", "PURSE"]
filteredAccounts = accounts에서 currency가 EXCLUDED_FROM_PNL에 포함된 항목 제외

totalBuyKrw = 0
totalEvaluationKrw = 0
FOR EACH acc IN filteredAccounts:
  IF acc.currency === "KRW" THEN krwBalance = balance; CONTINUE
  market = "KRW-" + currency
  ticker = tickersByMarket에서 market에 해당하는 티커
  price = ticker ? ticker.trade_price : avg_buy_price
  totalBuyKrw += avg_buy_price * balance
  totalEvaluationKrw += price * balance

RETURN {
  totalBuyKrw,
  totalEvaluationKrw: totalEvaluationKrw + krwBalance,  // 현재 총자산 = 코인평가+KRW
  orderableKrw: krwBalance,
  totalBuyKrwForCoins: totalBuyKrw,
  evaluationKrwForCoins: totalEvaluationKrw
}
```

```
수익률 공식 (고정):
  profitPct = (totalBuyKrwForCoins > 0)
    ? ((totalEvaluationKrw - totalBuyKrwForCoins) / totalBuyKrwForCoins) * 100
    : 0

  totalEvaluationKrw = 현재 총자산(KRW 잔고 + 코인 평가액, APENFT·PURSE 제외)
  totalBuyKrwForCoins = 총 매수금액(코인만, 동일 제외)
```

- emitDashboard()에서 위 공식으로 profitSummary.profitPct 계산 후 Socket.IO로 전송 → 웹(모바일/PC)과 디스코드 Embed가 동일 값 사용.

---

## 6. Gemini API (lib/gemini.js)

```
공통: GEMINI_API_KEY 필수. 모듈 없거나 키 없으면 null 반환.

askGeminiForScanVol(enriched):
  모델: gemini-2.5-flash
  입력: 상위 10종목 [symbol, price, rsi, strength, volumeChange]
  프롬프트: "가장 유력한 급등 후보 1종목 + 선정 이유/기술적 근거/주의 리스크 3줄 형식"
  RETURN 응답 텍스트

askGeminiForMarketSummary(ctx):
  모델: gemini-2.5-flash
  입력: { fng, btcTrend, topTickers, kimp }
  프롬프트: "3문단만 — 1) 시장 흐름 2) 추천 1종목+근거 3) 단기 전략"
  RETURN 응답 텍스트

askGeminiForScalpPoint(dataText):
  모델: gemini-2.5-flash
  입력: "[BTC] 현재가 ... | RSI ... | 체결강도 ... | 5분봉 추세 ..." 형식 여러 줄
  프롬프트: "제공된 RSI, 체결강도, 5분봉 데이터를 분석해서 지금 즉시 1% 수익 가능한 스캘핑 타점과 추천 종목을 알려줘. 3문단 이내."
  RETURN 응답 텍스트 (1900자 초과 시 말줄임)
```

---

## 7. MarketSearchEngine (market_search.js)

```
토큰: MARKET_BOT_TOKEN 또는 MARKET_SEARCH_ENGINE_TOKEN (DISCORD_TOKEN 사용 안 함)
채널: MARKET_SEARCH_ENGINE_CHANNEL_ID 또는 MARKET_CHANNEL_ID 또는 CHANNEL_ID

ready 시:
  해당 채널에 "가동 완료" Embed + 버튼 3개(급등주 분석, 시황 요약, 주요지표) 전송
  관리자 ID 있으면: 1시간마다 관리자 DM "영!차!" (헬스체크)

버튼 클릭 시:
  (관리자 검사 없음 — 시황 조회용)
  deferReply(ephemeral)
  action = customId에 따라 scan_vol | get_prompt | major_indicators
  GET {DASHBOARD_URL}/api/analyst/{action} 호출
  응답을 MessageEmbed로 변환 후 editReply(embeds)
  실패 시 "대시보드 서버가 켜져 있는지 확인하세요" 안내
```

- DASHBOARD_URL 기본: http://localhost:3000 (동일 PC에서 대시보드 제공 시).

---

## 8. 스케줄 작업

```
server.js (MyScalpBot 프로세스):

1) 4시간 시황 브리핑 (AI_ANALYSIS_CHANNEL_ID 설정 시만)
   주기: 4시간
   동작: 거래대금 상위 30종목 상승/하락 비율 + 상위 3 상승·하락 종목 → Embed
         discordBot.sendToChannelId(aiAnalysisChannelId, embed)

2) 1시간 헬스체크
   주기: 1시간 (첫 실행도 1시간 후)
   조건: discordBot.isOnline() === true
   동작: discordBot.sendDmToAdmin("가즈아")

market_search.js (MarketSearchEngine 프로세스):

3) 1시간 헬스체크
   주기: 1시간 (첫 실행도 1시간 후)
   동작: client.users.fetch(effectiveAdminId) → user.send("영!차!")
```

---

## 9. 디스코드 채널·DM 정리

```
CHANNEL_ID (필수)
  - 제어 패널, 엔진 가동/정지 알림, 역할 A/B 버튼

TRADING_LOG_CHANNEL_ID (선택)
  - 매수/매도 체결 Embed만 전송. 미설정 시 CHANNEL_ID에 전송

AI_ANALYSIS_CHANNEL_ID (선택)
  - 4시간 시황 브리핑 Embed 전송. 미설정 시 4시간 브리핑 비실행

관리자 DM
  - 1시간 헬스체크: MyScalpBot → "가즈아", MarketSearchEngine → "영!차!"
  - sendDmToAdmin(message): client.users.fetch(effectiveAdminId) 후 user.send(message)
```

---

## 10. 대시보드(Socket.IO) 수익률 일치

```
emitDashboard():
  assets = state.assets (fetchAssets() 결과 = summarizeAccounts 적용)
  totalEval = assets.totalEvaluationKrw
  totalBuyKrw = assets.totalBuyKrwForCoins (또는 totalBuyKrw)
  profitKrw = totalEval - totalBuyKrw
  profitPct = (totalBuyKrw > 0) ? ((totalEval - totalBuyKrw) / totalBuyKrw) * 100 : 0
  state.lastEmit = { assets, profitSummary: { totalEval, totalBuyKrw, profitKrw, profitPct }, ... }
  io.emit("dashboard", state.lastEmit)

웹 클라이언트(public/js/app.js):
  수익률 표시 시: profitSummary.profitPct 우선 사용, 없으면 (totalEval/totalBuy - 1)*100
  totalEval = assets.totalEvaluationKrw 사용 → 모바일·PC 동일 값
```

---

## 11. 재연결·에러 처리 (MyScalpBot)

```
client.on("error"):
  scheduleReconnect()  // 30초 후 start(opts) 재호출

client.on("disconnect"):
  scheduleReconnect()

scheduleReconnect():
  clearReconnectTimer()
  IF startOpts.token 없음 THEN return
  reconnectTimer = setTimeout(30초 후, start(startOpts) 호출)
  실패 시 scheduleReconnect() 재호출
```

---

## 12. 인프라·로그

```
PM2:
  - ecosystem.config.cjs로 upbit-bot, MarketSearchEngine 동시 실행
  - pm2-logrotate 권장: max_size 10M, retain 7 (docs/PM2_LOGS_AND_STARTUP.md)

Windows 부팅 시 자동 시작:
  - 작업 스케줄러로 scripts/pm2-resurrect-on-boot.bat 실행 (pm2 resurrect)
```

---

이 문서를 ChatGPT에 붙여넣고 **「위 수도코드 기준으로 개선할 수 있는 점(보안, 성능, 유지보수성, UX, 오류 처리)을 제안해 달라」** 고 요청하면 됩니다.
