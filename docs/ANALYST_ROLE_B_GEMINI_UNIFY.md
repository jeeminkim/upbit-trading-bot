# 역할 B — Gemini 2.5 Flash 통일 및 Fallback 설계

역할 B 4개 기능을 .env GEMINI_API_KEY(Gemini 2.5 Flash) 기준으로 통일하고, 로컬 규칙 fallback을 유지한 변경 사항 정리.

---

## 1. 변경 파일 목록

| 파일 | 변경 내용 |
|------|-----------|
| `lib/gemini.js` | `askGeminiForNoTradeDiagnosis` 구조화 입력용 프롬프트 + try/catch/null 반환. `askGeminiForLogicSuggestion` 원칙 반영 프롬프트 + try/catch/null 반환. |
| `server.js` | `analystHandlers.diagnoseNoTrade`: 구조화 입력 구성 → Gemini 호출 → 성공 시 Embed에 Gemini 결과, 실패/미사용 시 로컬 요약. diagnosticsStore에 **최종 사용한 요약** 누적. |
| `server.js` | `analystHandlers.suggestLogic`: 로컬 제안 먼저 생성 → Gemini 호출(원칙+누적 진단) → 성공 시 Gemini 결과, 실패 시 로컬 제안. |
| `lib/diagnoseNoTradeAnalyzer.js` | **변경 없음.** `buildDiagnoseSummary` / `buildSuggestSummary` 계속 사용( fallback 및 Gemini 입력 보조). |

---

## 2. 설계 요약

- **거래 부재 원인 진단**
  - 매번 로컬 요약(`buildDiagnoseSummary`) 생성.
  - Gemini용 **구조화 텍스트** 구성: 12h 매매/거절 건수, 거절 사유 샘플, 프로필(entry_score_min, strength_threshold, rsi_oversold), orderableKrw, 엔진 가동 여부, 종목별 마지막 거절, 로컬 진단 요약.
  - `geminiEnabled === true`일 때만 `askGeminiForNoTradeDiagnosis(structuredForGemini)` 호출.
  - 반환값이 유효(비빈 문자열, 10자 이상)면 Embed 설명에 Gemini 결과 사용, 아니면 로컬 요약 사용.
  - **diagnosticsStore**에는 **구조화 항목**을 push: `{ ts, source: 'gemini'|'local', localSummary, finalBody, meta }`. meta에는 trades12h/rejects12h 건수, topRejectReasons, entryScoreMin, strengthThreshold, orderableKrw, botEnabled 포함. 수정안 제안 시 원인 카운트·거절 분포·profile 값 등 근거 데이터로 활용.

- **매매 로직 수정안 제안**
  - `diagnosticsStore.length >= 5`일 때만 진행.
  - **entries** = diagnosticsStore 항목(레거시 문자열은 `{ finalBody, meta: {} }`로 정규화).
  - baseSuggestion = `buildSuggestSummary(entries.map(e => e.finalBody))`.
  - Gemini 입력: [안전 원칙] + [누적 진단 요약]. 각 진단은 finalBody + **[메타]** (매매/거절 건수, entry_score_min, strength_threshold, orderableKrw, bot, topRejectReasons) 형식으로 전달해 품질 향상.
  - Gemini 반환값은 **validateLogicSuggestionResponse**로 검증(길이 10~2500, 위험 문구 미포함) 후 유효할 때만 사용, 아니면 baseSuggestion fallback.

- **공통**
  - `EngineStateStore.get().geminiEnabled === false`이면 Gemini 호출 없이 로컬만 사용.
  - API 예외, timeout, 빈/짧은 응답, `GEMINI_DELAY_MESSAGE` 반환 시 모두 fallback.
  - Embed footer에 **프롬프트 버전** 표기: 진단은 `prompt v1`, 수정안은 `logic v2`. 품질 추적·프롬프트 변경 시 버전만 올려 추적 가능.
  - 조언자의 한마디 / 하루치 로그 분석은 기존 Gemini 경로 그대로 유지.

---

## 3. Fallback 동작

| 상황 | 거래 부재 진단 | 수정안 제안 |
|------|----------------|-------------|
| `geminiEnabled === false` | 로컬 요약만 사용 | 로컬 제안만 사용 |
| Gemini API 예외 / timeout | 로컬 요약 사용, handleGeminiError 호출 | 로컬 제안(baseSuggestion) 사용 |
| Gemini가 null/빈 문자열/10자 미만 반환 | 로컬 요약 사용 | 로컬 제안 사용 |
| Gemini가 GEMINI_DELAY_MESSAGE 반환 | gemini.js에서 null 반환 → 로컬 요약 사용 | 로컬 제안 사용 |
| 수정안: validateLogicSuggestionResponse 실패(위험 문구·길이) | — | 로컬 제안 사용 |
| 정상 응답 | Embed에 Gemini 3줄 요약, footer "Gemini 2.5 Flash · prompt v1" | Embed에 Gemini 제안, footer "Gemini 2.5 Flash · logic v2" |

---

## 4. 검증 포인트

1. **거래 부재 원인 진단**
   - Discord 버튼 클릭 시 `diagnoseNoTrade` 호출.
   - `geminiEnabled === true`이고 API 정상 → Embed 설명이 Gemini 3줄 요약, footer "Gemini 2.5 Flash".
   - `geminiEnabled === false` 또는 API 실패/빈 응답 → Embed 설명이 로컬 3줄 요약, footer "로컬 분석 (fallback)".
   - diagnosticsStore에 **구조화 항목**({ ts, source, localSummary, finalBody, meta })이 누적되고, suggestLogic에서 5건 이상일 때 finalBody + meta로 누적 진단 텍스트를 만들어 제안 생성.

2. **매매 로직 수정안 제안**
   - 진단 5건 미만 → 기존과 동일하게 "데이터 부족" Embed.
  - 5건 이상 + geminiEnabled + API 성공 + validateLogicSuggestionResponse 통과 → Embed에 Gemini 제안, footer "Gemini 2.5 Flash · logic v2".
  - 5건 이상 + (geminiEnabled false / API 실패 / 검증 실패) → Embed에 buildSuggestSummary 결과, footer "로컬 분석 (fallback) · v2".

3. **조언자 / 하루치 로그**
   - `advisorOneLiner`, `dailyLogAnalysis` 코드 경로·호출부 변경 없음. 기존대로 Gemini만 사용.

4. **diagnoseNoTradeAnalyzer**
   - `buildDiagnoseSummary`, `buildSuggestSummary` 시그니처 및 반환값 변경 없음. server.js에서만 호출 방식 확장.

---

## 5. 코드 변경 요약 (패치 개요)

### lib/gemini.js

- **askGeminiForNoTradeDiagnosis(structuredDiagnosisText)**  
  - 프롬프트: "구조화한 진단 입력" 기준 3줄 요약 요청.  
  - try/catch에서 예외 시 null, billing/quota 시 콜백 호출.  
  - 반환: null 또는 10자 이상 trimmed 문자열(500자 초과 시 497+ '…').

- **askGeminiForLogicSuggestion(principleAndAccumulatedText)**  
  - 프롬프트: "안전 원칙 + 누적 진단"을 주고, 보수적·1~2개·20줄 이내·근거 없는 완화 금지 명시.  
  - try/catch 및 반환 정책은 위와 동일. 2500자 초과 시 2497+ '…'.

### server.js

- **diagnoseNoTrade**
  - 로컬 요약 + 구조화 텍스트 구성 후, geminiEnabled 시 `askGeminiForNoTradeDiagnosis(structuredForGemini)` 호출. 유효하면 body = Gemini, 아니면 로컬.
  - diagnosticsStore.push({ ts, source, localSummary, finalBody: body, meta: { trades12h, rejects12h, topRejectReasons, entryScoreMin, strengthThreshold, orderableKrw, botEnabled } }).
  - Embed footer: usedGemini ? `Gemini 2.5 Flash · prompt ${DIAGNOSIS_PROMPT_VERSION}` : `로컬 분석 (fallback) · ${DIAGNOSIS_PROMPT_VERSION}`.

- **suggestLogic**
  - entries = diagnosticsStore 정규화(문자열 항목은 { finalBody, meta: {} }로).
  - baseSuggestion = buildSuggestSummary(entries.map(e => e.finalBody)).
  - 누적 진단 텍스트: 각 entry에 대해 finalBody + [메타] (매매/거절 건수, entry_score_min, strength_threshold 등) 형식으로 구성.
  - geminiEnabled 시 [안전 원칙] + [누적 진단 요약]으로 askGeminiForLogicSuggestion 호출. **validateLogicSuggestionResponse**(길이 10~2500, 위험 문구 미포함) 통과 시에만 body = Gemini.
  - Embed footer: usedGemini ? `Gemini 2.5 Flash · logic ${LOGIC_PROMPT_VERSION}` : `로컬 분석 (fallback) · ${LOGIC_PROMPT_VERSION}`.

---

## 6. 추가 정리 (3가지)

1. **diagnosticsStore 구조화**  
   최종 문장만 넣지 않고, 수정안 제안 품질을 위해 **원인 카운트·거절 분포·profile 값·근거 데이터**를 함께 저장.  
   항목 형식: `{ ts, source: 'gemini'|'local', localSummary, finalBody, meta }`. meta에 trades12h/rejects12h 건수, topRejectReasons, entryScoreMin, strengthThreshold, orderableKrw, botEnabled 포함. suggestLogic에서 누적 진단을 만들 때 finalBody와 meta를 함께 Gemini에 전달.

2. **수정안 제안 응답 품질 검증**  
   Gemini 응답 10자 기준만으로는 짧은 정상 답·긴 헛소리 구분이 어려우므로, **validateLogicSuggestionResponse** 도입.  
   - 길이 10~2500 허용.  
   - 위험 문구 포함 시 fallback: "모든 기준을 낮추세요", "전부 완화", "일괄 낮추세요", "기준 전부 완화" 등.  
   (추후 확장: 줄 수 제한 충족, 금지 문구, [답변 종료] 마커, "기준 낮추세요" 등 위험한 과도 제안 패턴.)

3. **진단/수정안 프롬프트 버전 관리**  
   footer(및 필요 시 로그)에 짧은 버전 표기로 품질 추적.  
   - 진단: `DIAGNOSIS_PROMPT_VERSION = 'v1'` → "Gemini 2.5 Flash · prompt v1".  
   - 수정안: `LOGIC_PROMPT_VERSION = 'v2'` → "Gemini 2.5 Flash · logic v2".  
   프롬프트 수정 시 해당 상수만 올리면 "왜 어제보다 오늘 이상해졌지?" 추적 가능.

---

이 문서와 실제 diff를 함께 보면, 역할 B의 Gemini 통일과 fallback 동작을 코드 기준으로 추적할 수 있다.
