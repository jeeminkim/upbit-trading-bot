# 로그 정책 및 비상 제어 버튼

## 1) 변경 파일 목록

### 수정 파일
- `src/packages/core/src/LogUtil.ts` — **신규**
- `src/packages/core/src/index.ts` — LogUtil export 추가
- `src/packages/core/src/PermissionService.ts` — admin_emergency_menu, admin_cleanup_processes, admin_force_kill_bot 권한 추가
- `src/apps/discord-operator/src/index.ts` — LogUtil 적용, 비상 제어 메뉴·확인 플로우·confirm 처리
- `src/apps/api-server/src/index.ts` — LogUtil import, POST /api/admin/cleanup-processes, POST /api/admin/force-kill-bot 추가
- `lib/signalEvaluationLogger.js` — LOG_LEVEL=DEBUG 일 때만 signal_evaluation 출력, timestamp 추가
- `lib/strategy/orchestrator.js` — LOG_LEVEL=DEBUG 일 때만 logTag 콘솔 출력, timestamp 추가

### 추가 파일
- `src/packages/core/src/LogUtil.ts` — 공통 로그 헬퍼 (timestamp, LOG_LEVEL)
- `docs/LOG_POLICY_AND_EMERGENCY_BUTTONS.md` — 본 문서

---

## 2) 현재 로그 구조 감사 결과

- **과다 로그**
  - `lib/signalEvaluationLogger.js`: 매 평가마다 `console.log(JSON.stringify({ type: 'signal_evaluation', ... }))` — **LOG_LEVEL=DEBUG일 때만 출력하도록 변경**
  - `lib/strategy/orchestrator.js`: `logTag()` 호출 시마다 `console.log` — **DEBUG일 때만 출력하도록 변경**
- **timestamp 누락**
  - discord-operator: `console.log('[DISCORD_BOOT]...')` 등에 timestamp 없음 — **LogUtil 사용으로 [ISO] [LEVEL] [TAG] 형식 통일**
  - signal_evaluation: ts 필드는 있으나 로그 라인 자체에 ISO 없음 — **DEBUG 시 `[${ts}] [DEBUG] [signal_evaluation]` 접두어 추가**
- **줄인 로그**
  - signal_evaluation: NORMAL/ERROR_ONLY에서 미출력
  - orchestrator logTag: NORMAL/ERROR_ONLY에서 미출력
  - discord-operator: ENV/상세 부팅은 DEBUG에서만, error/warn/핵심(패널 복구·로그인·admin 실행)은 LogUtil로 timestamp와 함께 유지

---

## 3) 설계 요약

### Timestamp 공통화
- **LogUtil** (`packages/core/src/LogUtil.ts`): `formatLog(level, tag, message, meta)` → `[ISO] [LEVEL] [TAG] message meta`
- 환경변수: `LOG_LEVEL` 또는 `RUNTIME_LOG_MODE` — `ERROR_ONLY` | `NORMAL` | `DEBUG` (기본 NORMAL)
- NORMAL: error·warn 출력, info/debug 억제. discord-operator·api-server는 LogUtil 사용.

### 정보성 로그 억제
- signal_evaluation: `LOG_LEVEL !== 'DEBUG'` 이면 return.
- orchestrator logTag: decisionLog에는 항상 push, 콘솔 로그는 `LOG_LEVEL === 'DEBUG'` 일 때만 + ISO prefix.

### 비상 관리자 버튼
- **메인 패널**: Row 3의 "프로세스 재기동"을 **"비상 제어"** (`admin_emergency_menu`)로 교체.
- **비상 제어** 클릭 시 ephemeral 하위 메뉴: **비상 프로세스 정리** | **강제 종료(taskkill)** | **프로세스 재기동**.
- **비상 프로세스 정리** (`admin_cleanup_processes`): 권한 체크 → 확인 플로우 → 확인 시 POST /api/admin/cleanup-processes.
- **강제 종료** (`admin_force_kill_bot`): 권한 체크 → 확인 플로우 → 확인 시 POST /api/admin/force-kill-bot.

### taskkill / cleanup 안전장치
- **대상 제한**: PM2 앱 이름 `market-bot`, `discord-operator`만 대상. `api-server`는 제외(자신 프로세스 보호).
- **cleanup-processes**: `.server.lock` 존재 시 lock 내 pid에 대해 `process.kill(pid, 0)` 실패(프로세스 없음)할 때만 lock 파일 삭제.
- **force-kill-bot**: `pm2 jlist`로 프로세스 목록 조회 후, 위 앱 이름만 필터, `process.pid`(api-server)와 일치하는 PID는 건너뜀. Windows는 `taskkill /PID x /F`, 비-Windows는 `SIGKILL`.
- **권한**: PermissionService.can(ctx, customId)로 ADMIN 이상만 허용.
- **확인**: ConfirmFlow로 2단계 확인 후에만 실행.

---

## 4) 실제 코드 패치 요약

- **LogUtil**: `logError`/`logWarn`/`logInfo`/`logDebug`, 모두 `[ISO] [LEVEL] [TAG] message` 형식. NORMAL 시 WARN 이상만 출력.
- **discord-operator**: 전역 `console.log`/`error`/`warn` → LogUtil 교체. Row 3 `admin_simple_restart` → `admin_emergency_menu`. `buildEmergencySubmenuComponents()` 추가. `admin_emergency_menu` 클릭 시 ephemeral 3버튼. `admin_cleanup_processes`/`admin_force_kill_bot` 클릭 시 권한 체크 후 ConfirmFlow 생성, confirm_ 토큰 소비 시 API 호출 후 `interaction.update`로 결과 표시.
- **api-server**: `POST /api/admin/cleanup-processes` — .server.lock 읽어 pid 미존재 시 lock 삭제, 결과 요약 반환. `POST /api/admin/force-kill-bot` — pm2 jlist 파싱, market-bot/discord-operator만 taskkill, killed/failed 배열 및 summary 반환. 모두 LogUtil.logWarn으로 실행·완료 로그 (NORMAL에서도 노출).
- **signalEvaluationLogger**: `LOG_LEVEL !== 'DEBUG'` 이면 return. DEBUG일 때만 `[ISO] [DEBUG] [signal_evaluation]` + JSON.
- **orchestrator**: `logTag`에서 decisionLog는 유지, 콘솔 출력은 `LOG_LEVEL_ORCH === 'DEBUG'` 일 때만 + ISO prefix.

---

## 5) 검증 포인트

- **모든 주요 로그에 timestamp**: LogUtil 사용처는 `[ISO] [LEVEL] [TAG]` 형식. signal_evaluation/orchestrator는 DEBUG일 때 ISO prefix 적용.
- **error 로그 확실히 노출**: LogUtil.logError는 LOG_LEVEL 무관 항상 출력.
- **signal_evaluation 등 과다 로그 감소**: NORMAL에서 signal_evaluation·orchestrator logTag 콘솔 미출력.
- **관리자 버튼 권한**: admin_emergency_menu, admin_cleanup_processes, admin_force_kill_bot 전에 PermissionService.can 실패 시 "권한 없음" ephemeral.
- **Confirm Flow 후에만 실행**: admin_cleanup_processes / admin_force_kill_bot 은 확인 버튼 눌렀을 때만 confirm_ 토큰 소비 후 API 호출.
- **stale lock / 좀비 정리**: cleanup-processes는 lock 파일 내 pid가 실제로 없을 때만 lock 삭제. force-kill-bot은 pm2 jlist로 market-bot·discord-operator PID만 taskkill.

---

## 환경변수

| 변수 | 설명 | 기본값 |
|------|------|--------|
| LOG_LEVEL 또는 RUNTIME_LOG_MODE | ERROR_ONLY / NORMAL / DEBUG | NORMAL |

- **ERROR_ONLY**: error만 출력.
- **NORMAL**: error, warn, (핵심 이벤트는 logWarn으로 유지).
- **DEBUG**: signal_evaluation, orchestrator logTag, discord ENV 등 정보성 로그까지 출력.
