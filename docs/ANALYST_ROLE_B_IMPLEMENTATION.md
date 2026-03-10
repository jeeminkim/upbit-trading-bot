# 역할 B — 정보 분석가 모드: 핵심 구현 정리

다른 LLM이 조언할 수 있도록, Discord 「역할 B — 정보 분석가」의 **거래 부재 원인 진단**, **매매 로직 수정안 제안**, **조언자의 한마디**, **하루치 로그(일 단위) 분석** 네 기능의 버튼·이벤트·핵심 로직을 정리한 문서입니다.

---

## 1. 진입점: Discord 버튼 → 이벤트 라우팅

### 1.1 버튼 정의 (역할 B 패널)

**파일:** `lib/discordBot.js`

- **패널 전송:** `sendAnalystPanel(ch)` (516행 근처) — "📋 역할 B — 정보 분석가 (The Analyst)" 메시지 + `buildAnalystRow()` 버튼들.
- **버튼 행 구성:** `buildAnalystRow()` (339~351행)
  - **row2 (역할 B 핵심 4개):**
    - `analyst_diagnose_no_trade` — "🔍 거래 부재 원인 진단"
    - `analyst_suggest_logic` — "💡 매매 로직 수정안 제안"
    - `analyst_advisor_one_liner` — "🧐 조언자의 한마디"
    - `daily_log_analysis` — "📋 하루치 로그 (일 단위) 분석"

### 1.2 버튼 클릭 시 라우팅

**파일:** `lib/discordBot.js` — `interaction.isButton()` 분기 내부

| customId | 동작 |
|----------|------|
| `daily_log_analysis` | `handlers.analyst.dailyLogAnalysis()` 호출 → **텍스트 응답** (`result.content`) → 2000자 단위로 쪼개어 `editReply` + `followUp` (189~198행) |
| `analyst_advisor_one_liner` | `handlers.analyst.advisorOneLiner()` 호출 → **텍스트 응답** (`result.content`) → 동일하게 2000자 단위 전송 (200~210행) |
| `analyst_diagnose_no_trade` | **관리자 체크** (`effectiveAdminId`와 일치해야 함). `handleAnalystButton('analyst_diagnose_no_trade')` → **Embed** 반환 → `editReply({ embeds: [embed] })` (212~224행) |
| `analyst_suggest_logic` | 동일하게 관리자만. `handleAnalystButton('analyst_suggest_logic')` → **Embed** 반환 (212~224행) |

- **handleAnalystButton(customId)** (328~336행):  
  `handlers.analyst`에서 `diagnoseNoTrade` / `suggestLogic` / `advisorOneLiner` 등 매핑.  
  `dailyLogAnalysis`와 `advisorOneLiner`는 위에서 별도 분기로 호출되며, **Embed가 아닌 `{ content }`** 를 사용.

- **handlers 주입:** `server.js`에서 Discord 봇 초기화 시 `discordHandlers.analyst = analystHandlers`로 전달.  
  즉 **실제 비즈니스 로직은 `server.js` 내 `analystHandlers` 객체**에 있음.

---

## 2. 거래 부재 원인 진단 (🔍 거래 부재 원인 진단)

### 2.1 흐름 요약

1. Discord: `analyst_diagnose_no_trade` 클릭 → 관리자 확인 → `handlers.analyst.diagnoseNoTrade()` 호출.
2. **server.js** `analystHandlers.diagnoseNoTrade()` (2775~2829행):
   - **데이터 수집**
     - `db.getTradesSinceHours(12)`, `db.getRejectLogsSinceHours(12)` (최근 12시간 매매·거절).
     - `tradeLogger.getRecentLogs()` (실시간 로그 버퍼).
     - `scalpEngine.getProfile()` (entry_score_min, strength_threshold 등).
     - `state.assets`, `state.botEnabled`, `lastRejectBySymbol` (종목별 마지막 거절 사유).
   - **요약 생성:** `diagnoseNoTradeAnalyzer.buildDiagnoseSummary({ trades12h, reject12h, profile, assets, lastRejectBySymbol, botEnabled })`.
   - **누적 저장:** `diagnosticsStore.push(summary)` (최대 20건, `DIAGNOSTICS_STORE_MAX`). `suggestLogic`은 이 누적 데이터 사용.
   - **응답:** Discord Embed — 제목 "🔍 거래 부재 원인 진단", 설명 = 위에서 만든 3줄 요약 + 수집 데이터 필드.

### 2.2 진단 요약 생성 (로컬 규칙, Gemini 미사용)

**파일:** `lib/diagnoseNoTradeAnalyzer.js`

- **함수:** `buildDiagnoseSummary(opts)`
- **입력:**  
  `trades12h`, `reject12h`, `profile`, `assets`, `lastRejectBySymbol`, `botEnabled`
- **로직 요약:**
  - 엔진 꺼짐 → "엔진이 꺼져 있어 매매가 발생하지 않습니다."
  - 주문 가능 원화 &lt; 5000 → "주문 가능 원화가 부족합니다."
  - `reject12h`가 있으면 거절 사유 키워드로 분류 (RSI/진입점수, 스프레드, 유동성, 김프 등) → 해당하는 1개 문장 추가.
  - 매매가 있으면 "정상 체결 중" 문장.
  - 위에서 아무것도 없으면 "데이터 없음/적음" + 현재 설정(entry_score_min 등) 안내.
- **출력:** 위 규칙으로 만든 **3줄 이내** 문자열 (줄바꿈으로 연결).

### 2.3 참고: Gemini 경로 (현재 미사용)

- **lib/gemini.js** `askGeminiForNoTradeDiagnosis(logDataText)` (288~293행):  
  12시간 로그 텍스트를 받아 "왜 거래가 체결되지 않았는지" 3줄 요약 생성.  
  **현재 server.js 쪽에서는 호출하지 않고**, 진단은 전부 `diagnoseNoTradeAnalyzer.buildDiagnoseSummary` 로컬 규칙만 사용.

---

## 3. 매매 로직 수정안 제안 (💡 매매 로직 수정안 제안)

### 3.1 흐름 요약

1. Discord: `analyst_suggest_logic` 클릭 → 관리자 확인 → `handlers.analyst.suggestLogic()` 호출.
2. **server.js** `analystHandlers.suggestLogic()` (2831~2857행):
   - **조건:** `diagnosticsStore.length >= MIN_DIAGNOSTICS_FOR_SUGGEST` (5회 이상).  
     미달 시 Embed로 "데이터가 부족합니다 (현재 N/5). 「거래 부재 원인 진단」 버튼을 여러 번 실행해 진단을 쌓아 주세요." 반환.
   - **제안 생성:** `diagnoseNoTradeAnalyzer.buildSuggestSummary(diagnosticsStore)`  
     → 진단 요약 문자열 배열을 받아 수정안 텍스트 생성.
   - **응답:** Embed — 제목 "💡 매매 로직 수정안 제안", 설명 = 위에서 만든 제안 문구.

### 3.2 수정안 생성 (로컬 규칙, Gemini 미사용)

**파일:** `lib/diagnoseNoTradeAnalyzer.js`

- **함수:** `buildSuggestSummary(diagnosticsStore)`
- **입력:** `diagnosticsStore` — 이전에 `diagnoseNoTrade()`에서 쌓은 **요약 문자열 배열** (최대 20건).
- **로직 요약:**
  - 전체 요약 텍스트를 소문자로 합친 뒤 키워드 매칭:
    - RSI/진입점수/entry_score → "entry_score_min 소폭 낮추기" 등.
    - 스프레드 → max_spread_pct 상향 주의.
    - 잔고/원화/orderable → 원화 유지·분산 투자 권장.
    - 김프 → kimp_block_pct 상향 시 김프 리스크 관리 안내.
    - 엔진 꺼짐 → 엔진 가동 후 데이터 쌓기 안내.
  - 매칭된 항목이 없으면 "공통 패턴이 뚜렷하지 않음" + entry_score_min/strength_threshold 단계적 조정 권장.
- **출력:** "누적 진단 N건 기준 제안:" 헤더 + **5줄 이내** 제안 문장들.

### 3.3 참고: Gemini 경로 (현재 미사용)

- **lib/gemini.js** `askGeminiForLogicSuggestion(accumulatedDiagnosticsText)` (297~302행):  
  누적 진단 텍스트를 받아 scalpEngine/전략 수정안을 5줄 이내로 제안.  
  **현재 server.js에서는 호출하지 않고**, 제안은 전부 `buildSuggestSummary` 로컬 규칙만 사용.

---

## 4. 조언자의 한마디 (🧐 조언자의 한마디)

### 4.1 흐름 요약

1. Discord: `analyst_advisor_one_liner` 클릭 → `handlers.analyst.advisorOneLiner()` 호출 (텍스트 응답).
2. **server.js** `analystHandlers.advisorOneLiner()` (2889~2908행):
   - **입력 수집**
     - `tradeHistoryLogger.getLastTradesForAdvisor(3)` — 최근 거래 3건 (매도 우선, 없으면 매수 포함).
     - `tradeHistoryLogger.getStrategyMemory()` — `data/strategy_memory.txt` 내용 (과거 교훈).
   - **Gemini 호출:** `gemini.askGeminiForAdvisorAdvice(tradesText, memoryText)`.
   - **교훈 저장:** 반환값의 `lesson`이 있으면 `tradeHistoryLogger.appendStrategyMemory(lesson)` → strategy_memory.txt에 한 줄 추가 (최대 100줄 유지).
   - **응답:** Discord에 `analysis` 텍스트 전송 (2000자 단위 분할).

### 4.2 거래 이력·메모리 소스

**파일:** `lib/tradeHistoryLogger.js`

- **getLastTradesForAdvisor(count=3):**
  - `data/trade_history.jsonl`에서 라인 단위 JSON 파싱.
  - 매도(sell) 우선, 부족하면 매수 포함해서 최근 `count`건 반환.
  - 항목: ticker, side, timestamp, price, quantity, net_return, reason, rsi, trend_score 등.
- **getStrategyMemory():** `data/strategy_memory.txt` 전체 내용 반환 (조언자 프롬프트에 "과거 교훈"으로 삽입).
- **appendStrategyMemory(lesson):** Gemini가 추출한 "조언:" 한 줄을 타임스탬프와 함께 append 후, 중복·빈 줄 제거하고 최대 100줄로 잘라 저장.

### 4.3 Gemini 조언자

**파일:** `lib/gemini.js` — `askGeminiForAdvisorAdvice(tradesText, memoryText)` (325~358행)

- **프롬프트 요지:**  
  "업비트 스캘핑 전문 조언자" 역할, [과거 교훈](memoryText) + [최근 거래 데이터](tradesText)를 주고:
  1) 성공/실패의 기술적 원인 (RSI, 거래량, 진입/청산 타점 등)  
  2) **"조언:"으로 시작하는 한 문장** (다음 매매 시 주의사항)  
  답변 끝에 `[답변 종료]` 출력.
- **출력 처리:**  
  응답 텍스트에서 "조언: ..." 정규식으로 `lesson` 추출 (없으면 마지막 비빈 줄).  
  `lesson`은 최대 300자로 잘라 `strategy_memory.txt`에 저장하는 데 사용.
- **반환:** `{ analysis, lesson }` — Discord에는 `analysis`만 노출.

---

## 5. 하루치 로그(일 단위) 분석 (📋 하루치 로그 (일 단위) 분석)

### 5.1 흐름 요약

1. Discord: `daily_log_analysis` 클릭 → "오늘자 로그 수집·분석 중… (일 단위)" 로딩 메시지 → `handlers.analyst.dailyLogAnalysis()` 호출.
2. **server.js** `analystHandlers.dailyLogAnalysis()` (2859~2887행):
   - **로그 수집:** `readTodayLogContent()` (server.js 2576~2598행)
     - `logs/` 디렉터리에서 `.log` 파일만 대상 (이름에 `%` 포함 파일 제외, pm2 템플릿 제외).
     - **오늘 날짜** (`new Date().toISOString().slice(0,10)`)가 포함된 라인만 필터.
     - 파일당 최대 400000 바이트, 꼬리 부분 사용.
     - 결과: `[파일: xxx.log]\n` + 해당 라인들 여러 파일 이어붙임.
   - **DB 요약 (선택):**  
     `db.getTradesSinceHours(24)`, `db.getRejectLogsSinceHours(24)`, `db.getTodayStats()`  
     → 당일 거래/거절 건수, PnL, 승률, 최근 거래·거절 샘플을 문자열로 만들어 `dbContext`에 넣음.
   - **AI 분석:** `EngineStateStore.get().geminiEnabled`가 true일 때만 진행.  
     `gemini.askGeminiForLogAnalysis(logText, dbContext)` 호출.
   - **응답:** `{ content: analysis }` — 분석 결과를 2000자 단위로 Discord에 전송.

### 5.2 Gemini 로그 분석

**파일:** `lib/gemini.js` — `askGeminiForLogAnalysis(logText, dbContext)` (305~317행)

- **프롬프트 요지:**  
  "오늘 하루치 로그" (+ 선택적으로 "당일 DB 요약")를 주고,  
  오류(에러, Error, Exception, fail, 오류, 에러 등)가 있으면:
  1) 어떤 파일·모듈에서 발생했는지 (파일 경로·함수명)  
  2) 원인 추정  
  3) 어디를 어떻게 수정하면 좋을지 (파일명·라인 근처·Cursor에서 바로 고칠 수 있게)  
  5~10줄 이내 요약. 오류 없으면 "오늘자 로그에서 오류 없음"만 출력.  
  답변 끝에 `[답변 종료]` 출력.
- **입력:** 로그 텍스트는 앞쪽 28000자만 사용.
- **현재:** 이 경로만 사용. `lib/openaiLogAnalyzer.js`의 `askChatGPTForLogAnalysis`는 **호출처 없음** (Gemini만 사용).

---

## 6. 공통·부가 사항

### 6.1 상태·저장소 (server.js)

- **diagnosticsStore** (2571~2574행):  
  거래 부재 진단 요약 문자열 배열. 최대 20건 (`DIAGNOSTICS_STORE_MAX`).  
  `diagnoseNoTrade()` 실행 시마다 `buildDiagnoseSummary` 결과를 push하고, 초과분은 shift.  
  `suggestLogic()`은 이 배열 길이가 5 이상일 때만 `buildSuggestSummary(diagnosticsStore)` 호출.
- **readTodayLogContent** (2576~2598행):  
  당일 로그만 수집하는 함수. `dailyLogAnalysis()`에서만 사용.

### 6.2 API 라우트 (HTTP)

**파일:** `server.js` (2913~2967행 근처)

- `GET /api/analyst/diagnose_no_trade` → `analystHandlers.diagnoseNoTrade()` → Embed JSON.
- `GET /api/analyst/suggest_logic` → `analystHandlers.suggestLogic()` → Embed JSON.

(조언자의 한마디·하루치 로그는 Discord 버튼에서만 `handlers.analyst`로 호출되며, 위와 같은 전용 HTTP API는 없음.)

### 6.3 권한

- `analyst_diagnose_no_trade`, `analyst_suggest_logic`:  
  `effectiveAdminId`가 설정되어 있으면, 클릭한 사용자 ID가 같을 때만 실행. 다르면 "관리자만 사용할 수 있습니다." 반환.

---

## 7. 파일·함수 인덱스 (다른 LLM용)

| 기능 | 진입점 (Discord) | 핵심 로직 (server) | 보조 모듈 |
|------|------------------|--------------------|-----------|
| 거래 부재 원인 진단 | `discordBot.js` customId `analyst_diagnose_no_trade` → `handleAnalystButton` | `server.js` `analystHandlers.diagnoseNoTrade` (2775~2829) | `lib/diagnoseNoTradeAnalyzer.js` `buildDiagnoseSummary` |
| 매매 로직 수정안 제안 | `analyst_suggest_logic` → `handleAnalystButton` | `analystHandlers.suggestLogic` (2831~2857) | `lib/diagnoseNoTradeAnalyzer.js` `buildSuggestSummary` |
| 조언자의 한마디 | `analyst_advisor_one_liner` → `handlers.analyst.advisorOneLiner` | `analystHandlers.advisorOneLiner` (2889~2908) | `lib/tradeHistoryLogger.js` getLastTradesForAdvisor, getStrategyMemory, appendStrategyMemory / `lib/gemini.js` askGeminiForAdvisorAdvice |
| 하루치 로그 분석 | `daily_log_analysis` → `handlers.analyst.dailyLogAnalysis` | `analystHandlers.dailyLogAnalysis` (2859~2887) + `readTodayLogContent` (2576~2598) | `lib/gemini.js` askGeminiForLogAnalysis |

이 문서만 전달하면, 다른 LLM이 "거래 부재 진단·수정안 제안·조언자·일 단위 로그 분석"의 현재 구현 방식을 파악하고, 개선안(로직·프롬프트·데이터 소스·UX)을 제안하는 데 필요한 핵심 로직을 모두 참고할 수 있습니다.
