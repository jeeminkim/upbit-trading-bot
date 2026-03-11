# Discord 통제 패널 체크리스트 대비 구현 상태

PM2 올리기 전·점검 시 이 문서와 실제 코드/동작을 대조하면 됩니다.

---

## 1. 공통 체크

### A. 패널 구조

| 확인 포인트 | 구현 위치 | 상태 |
|------------|----------|------|
| 역할 A — 현장 지휘관 섹션 제목/설명 | `restorePanel()` panelContent | ✅ `**역할 A — 현장 지휘관** (엔진 제어 · 실시간 상태 · 체결 보고)` |
| 역할 B — 정보 분석가 섹션 제목/설명 | 동일 | ✅ `**역할 B — 정보 분석가** (AI 실시간 타점 분석 · 시황 요약 · 주요지표 · 거래 부재 진단)` |
| 역할 C — 서버 관리자 섹션 제목/설명 | 동일 | ✅ `**역할 C — 서버 관리자** (시스템 업데이트 · 프로세스 재기동)` |
| 역할 B 버튼 누락 여부 | `buildPanelComponents()` Row 4·5 | ✅ AI 타점, 시황, 급등주, 주요지표, 거래 부재 진단, 로직 제안, 조언자, 하루치 로그, API 사용량 |
| 역할 C 버튼 누락 여부 | Row 3·5 | ✅ 프로세스 재기동(Row3), 시스템 업데이트(Row5) |

### B. 버튼 노출

| 확인 포인트 | 구현 | 상태 |
|------------|------|------|
| SAFE/A-보수적/A-균형형/A-적극형이 메인에 상시 노출되지 않음 | 메인 패널에 `strategy_menu` 1개만 배치 | ✅ |
| 전략 버튼 클릭 후에만 4개 전략 노출 | `strategy_menu` 클릭 시 `buildStrategySubmenuComponents()`로 ephemeral 응답 | ✅ |
| 역할 B 분석 버튼 유지 | Row 4·5에 9개 버튼 | ✅ |
| 역할 C 관리자 버튼이 일반 버튼과 섞이지 않음 | Row3 끝·Row5 끝에만 배치, 권한 체크로 실행 제한 | ✅ |

### C. customId ↔ 핸들러 연결

| 버튼 표시명 | custom_id | 핸들러(handleButton) |
|-------------|-----------|------------------------|
| 엔진 가동 | `engine_start` | API `/api/engine/start` + 권한 체크 |
| 즉시 정지 | `engine_stop` | ConfirmFlow → `/api/engine/stop` + 권한 체크 |
| 현재 상태 | `current_state` | `/api/status` → buildStatusEmbedFromApi |
| 현재 수익률 | `current_return` | `/api/pnl` → buildPnlEmbedFromApi |
| 전체 매도 | `sell_all` | ConfirmFlow → `/api/sell-all` + 권한 체크 |
| 경주마 ON/OFF | `race_horse_toggle` | `/api/race-horse-toggle` + 권한 체크 |
| 기준 완화 | `relax_toggle` | `/api/relax-status` → 필요 시 `/api/relax` 또는 연장 버튼 + 권한 체크 |
| 연장 (4시간) | `extend_relax` | `/api/relax-extend` + 권한 체크 |
| 초공격 scalp | `independent_scalp_start` | `/api/independent-scalp-status` → `/api/independent-scalp-start` + 권한 체크 |
| scalp 중지 | `independent_scalp_stop` | `/api/independent-scalp-stop` + 권한 체크 |
| 연장 (3시간) | `extend_independent_scalp` | `/api/independent-scalp-extend` + 권한 체크 |
| 전략 | `strategy_menu` | ephemeral에 SAFE/보수적/균형형/적극형 4버튼만 노출 |
| SAFE / A-보수적 / A-균형형 / A-적극형 | `strategy_safe` 등 | 기존 strategyModeMap → `/api/strategy-mode` (권한 체크 있음) |
| 현재전략 | `strategy_view_config` | `/api/strategy-config` |
| 최근스킵 | `strategy_skip_recent` | `/api/strategy-status` → skipTop5 embed |
| 최근체결 | `strategy_buy_recent` | `/api/strategy-status` → buyRecent5 embed |
| 헬스 | `health` | `/api/health` → buildHealthEmbedFromApi |
| AI 타점 분석 | `ai_analysis` | `/api/ai_analysis` (market-bot proxy) |
| 시황 요약 | `analyst_get_prompt` | `/api/analyst/summary` |
| 급등주 분석 | `analyst_scan_vol` | `/api/analyst/scan-vol` |
| 주요지표 | `analyst_indicators` | `/api/analyst/indicators` |
| 거래 부재 진단 | `analyst_diagnose_no_trade` | `/api/analyst/diagnose_no_trade` + 권한 체크 |
| 로직 수정안 제안 | `analyst_suggest_logic` | `/api/analyst/suggest_logic` + 권한 체크 |
| 조언자의 한마디 | `analyst_advisor_one_liner` | `/api/analyst/advisor_one_liner` |
| 하루치 로그 분석 | `daily_log_analysis` | `/api/analyst/daily_log_analysis` |
| API 사용량 | `api_usage_monitor` | `/api/analyst/api_usage_monitor` |
| 시스템 업데이트 | `admin_git_pull_restart` | `/api/admin/git-pull-restart` + 권한 체크 |
| 프로세스 재기동 | `admin_simple_restart` | `/api/admin/simple-restart` + 권한 체크 |

---

## 2. 역할 A 체크리스트 (담당 계층)

- **Discord/API (discord-operator + api-server)**  
  버튼 노출, customId, 권한 체크, API 호출, 응답 포맷(embed/텍스트)까지 담당.

- **백엔드 (market-bot = server.js + trading-engine)**  
  실제 상태 변경(botEnabled, cashLock, pausedAfterRestart, raceHorse, relaxed, scalp), 수익률 계산, 전체 매도 실행, 현재 상태/수익률 데이터 제공.

| 항목 | Discord/API | 백엔드 |
|------|-------------|--------|
| A-1 엔진 가동 | 버튼·권한·호출 ✅ | botEnabled, pausedAfterRestart 등 반영 (server.js) |
| A-2 즉시 정지 | 확인 플로우·호출 ✅ | 진입 중단, 청산 경로 유지 (server.js) |
| A-3 현재 상태 | embed 빌드·표시 ✅ | status API에서 botEnabled/cashLock/raceHorse/relax/scalp 등 제공 (market-bot /status) |
| A-4 현재 수익률 | embed 빌드·표시 ✅ | pnl API, 수익률 정의·qty=0 처리 (market-bot) |
| A-5 전체 매도 | 확인 플로우·호출 ✅ | sellAll 실행, botEnabled 무관·scalp 포지션 포함 (server.js) |
| A-6 경주마 ON/OFF | 버튼·권한·proxy ✅ | raceHorseActive, 만료, 9시/50% 정책 (server.js) |
| A-7 기준 완화 | 버튼·연장·proxy ✅ | relaxedUntil, profile 반영·만료 원복 (server.js) |
| A-8 초공격 scalp 시작/중지 | 버튼·연장·proxy ✅ | isRunning, priorityOwner, tickExit 등 (server.js) |
| A-9 전략 버튼 | 메인에 1개, 클릭 시 하위만 노출 ✅ | — |
| A-10 SAFE/보수/균형/적극 | 하위 메뉴에서만 노출·호출 ✅ | strategy-mode API, profile/state 반영 (api-server + market-bot) |
| A-11 현재전략 | strategy_view_config → strategy-config API ✅ | runtimeStrategyConfig 상태 |
| A-12 최근스킵 | strategy_skip_recent → strategy-status skipTop5 ✅ | StrategyExplainService 등 |
| A-13 최근체결 | strategy_buy_recent → strategy-status buyRecent5 ✅ | 동일 |

---

## 3. 역할 B 체크리스트

| 항목 | Discord/API | 백엔드 |
|------|-------------|--------|
| B-1 AI 실시간 타점 분석 | ai_analysis → /api/ai_analysis ✅ | market-bot discordHandlers.aiAutoAnalysis |
| B-2 시황 요약 | analyst_get_prompt → /api/analyst/summary ✅ | api-server GeminiAnalysisService |
| B-3 급등주 분석 | analyst_scan_vol → /api/analyst/scan-vol ✅ | api-server |
| B-4 주요지표 | analyst_indicators → /api/analyst/indicators ✅ | api-server |
| B-5 거래 부재 원인 진단 | analyst_diagnose_no_trade + 권한 ✅ | market-bot analyst.diagnoseNoTrade |
| B-6 매매 로직 수정안 제안 | analyst_suggest_logic + 권한 ✅ | market-bot analyst.suggestLogic |
| B-7 조언자의 한마디 | analyst_advisor_one_liner ✅ | market-bot analyst.advisorOneLiner |
| B-8 하루치 로그 분석 | daily_log_analysis ✅ | market-bot analyst.dailyLogAnalysis |
| B-9 API 사용량 조회 | api_usage_monitor ✅ | market-bot getApiUsageMonitor |

---

## 4. 역할 C 체크리스트

| 항목 | Discord/API | 백엔드 |
|------|-------------|--------|
| C-1 시스템 업데이트 | admin_git_pull_restart + **권한 체크** ✅ | market-bot adminGitPullRestart (실행 경로·git pull) |
| C-2 프로세스 재기동 | admin_simple_restart + **권한 체크** ✅ | market-bot adminSimpleRestart, PM2·pausedAfterRestart 정책 |
| C-3 관리자 권한 | ADMIN_ID / DISCORD_ADMIN_ID / ADMIN_IDS 사용, PermissionService.can()로 거절 ✅ | — |

권한: `PermissionService.ts`에서 `admin_git_pull_restart`, `admin_simple_restart`는 `PermissionLevel.ADMIN` 필요. `resolveLevel()`에서 ADMIN_ID, DISCORD_ADMIN_ID, SUPER_ADMIN_ID, ADMIN_IDS 반영.

---

## 5. 경주마 모드·재기동·cash lock·로그

- **전부 백엔드(server.js + trading-engine)** 에서 처리.
- Discord 패널은 “경주마 ON/OFF”, “즉시 정지”, “전체 매도” 등 **명령만 전달**하고,  
  FULL_50/MEDIUM_25, exit-first, cash lock 시 매수 금지, pausedAfterRestart, qty=0 방지, 로그 품질은 **서버/엔진 쪽**에서 검증해야 함.

---

## 6. PM2 올리기 전 최종 10개

| # | 확인 항목 | 담당 |
|---|-----------|------|
| 1 | 역할 A/B/C 섹션이 모두 보이는가 | ✅ 패널 content (restorePanel) |
| 2 | 전략 버튼이 메인에 1개만 보이는가 | ✅ buildPanelComponents |
| 3 | 전략 하위 버튼은 클릭 후에만 보이는가 | ✅ strategy_menu → buildStrategySubmenuComponents |
| 4 | 경주마/완화/scalp ON/OFF가 실제 상태값을 바꾸는가 | 백엔드 (market-bot) |
| 5 | 거래 부재 진단·수정안 제안·조언자·하루치 로그가 응답하는가 | ✅ proxy + market-bot 핸들러 |
| 6 | 재기동 후 자동 진입 금지 상태 유지되는가 | 백엔드 |
| 7 | cash lock이 신규 매수만 막고 청산은 허용하는가 | 백엔드 |
| 8 | qty=0가 더 이상 기록되지 않는가 | 백엔드 |
| 9 | Discord 관리자 버튼이 권한 체크를 하는가 | ✅ Role C + 엔진/매도/경주마/완화/scalp/진단·제안 권한 적용 |
| 10 | Discord bot 시작 로그가 반드시 찍히는가 | ✅ [DISCORD_BOOT], [DISCORD_ENV], [discord] startup panel restore 등 |

---

## 7. 추천 점검 순서

1. **패널 UI 구조** — 메시지 content에 역할 A/B/C 제목·설명 있는지, Row 1~5에 위 표의 버튼이 모두 있는지 확인.
2. **역할 A 버튼** — 엔진 가동/즉시 정지/현재 상태/수익률/전체 매도/경주마/완화/scalp/전략/현재전략/최근스킵/최근체결/헬스/재기동 클릭 시 응답·권한 동작 확인.
3. **전략 하위 메뉴** — “전략” 클릭 시에만 SAFE·A-보수적·A-균형형·A-적극형 노출, 선택 시 전략 전환 반영 확인.
4. **역할 B 분석 버튼** — AI 타점, 시황, 급등주, 주요지표, 거래 부재 진단, 로직 제안, 조언자, 하루치 로그, API 사용량 응답 확인.
5. **역할 C 관리자 버튼** — 시스템 업데이트·프로세스 재기동은 관리자만 성공, 비관리자 클릭 시 “권한 없음” 확인.
6. **재기동 복원 정책** — market-bot·trading-engine 쪽 pausedAfterRestart·자동 진입 금지 확인.
7. **cash lock / 청산 정책** — orderableKrw·신규 매수 차단·청산 허용 로직 확인 (백엔드).
8. **로그 품질** — 시작·READY·버튼 처리·실패 원인 로그 확인, 반복·qty=0·undefined 로그 없음 확인 (주로 백엔드).

---

## 8. 권한이 걸린 버튼 (관리자만 실행 가능)

- `engine_start`, `engine_stop`, `sell_all`
- `race_horse_toggle`, `relax_toggle`, `extend_relax`
- `independent_scalp_start`, `independent_scalp_stop`, `extend_independent_scalp`
- `strategy_safe` / `strategy_conservative` / `strategy_balanced` / `strategy_active` (전략 모드 전환)
- `analyst_diagnose_no_trade`, `analyst_suggest_logic`
- `admin_git_pull_restart`, `admin_simple_restart`

위 항목은 `PermissionService.can(ctx, customId)` 통과 시에만 API 호출되며, 실패 시 “권한 없음 (…)” ephemeral 응답만 반환됩니다.
