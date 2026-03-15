# 구동 전 점검 및 SAFE vs A_BALANCED 30분 비교 운영

- **현재 구현**: 전략 모드 시스템 1차, p0_gate_blocked Explain 로그, ORCHESTRATOR deprecated 정리 반영 완료.
- **추가 리팩터링 없음.** 아래 5개 수동 점검 후 바로 30분 비교 운영 진행 가능.

---

## 1. 구동 전 수동 테스트 5개

### 시나리오 1: API 단일 소스 검증

1. 서버 기동 (api-server 또는 server.js + trading-engine 구성에 맞게).
2. **GET** `/api/strategy-config`
   - 확인: `mode` = `SAFE`, `profile.thresholdEntry` = 0.62, `profile.minOrchestratorScore` = 0.62.
3. **POST** `/api/strategy-mode`  
   Body: `{ "mode": "A_BALANCED", "updatedBy": "dashboard" }`
4. 다시 **GET** `/api/strategy-config`
   - 확인: `mode` = `A_BALANCED`, `profile.thresholdEntry` = 0.38, `profile.minOrchestratorScore` = 0.38, `updatedBy`, `updatedAt` 존재.

**실패 시**: 단일 소스 구조 문제. `lib/runtimeStrategyConfig.js`만 상태를 갖는지 확인.

---

### 시나리오 2: Dashboard 동기화 검증

1. Discord 또는 API로 모드를 **A_BALANCED**로 전환.
2. Dashboard 접속 (예: `/console.html`) 후 새로고침 또는 WebSocket 자동 반영 대기.
3. **STRATEGY MODE** 카드 확인:
   - 모드 = A_BALANCED, threshold = 0.38, description·updatedBy·updatedAt 일치.

**실패 시**: Dashboard가 로컬 상태를 갖지 않고 `console:strategy_config`만 사용하는지 확인.

---

### 시나리오 3: Discord 권한 검증

| 계정   | 동작                 | 기대 결과        |
|--------|----------------------|-------------------|
| ADMIN  | 모드 버튼(SAFE 등) 클릭 | 모드 변경 성공    |
| ADMIN  | `/strategy-mode` 실행  | 모드 변경 성공    |
| VIEWER | 동일 모드 버튼 클릭     | "권한 없음 (ADMIN만…)" |
| VIEWER | `/strategy-mode` 실행  | 권한 없음         |
| VIEWER | `/strategy-status` 실행 | 조회만 성공       |
| VIEWER | `/strategy-skip-top` 실행 | 조회만 성공       |

**실패 시**: `PermissionService`에서 strategy-mode=ADMIN, strategy-status/strategy-skip-top=VIEWER 확인.

---

### 시나리오 4: EventBus / Audit 검증

1. 모드 변경 1회 실행 (Dashboard 버튼 또는 Discord 또는 POST `/api/strategy-mode`).
2. 확인:
   - **Audit**: `strategy_mode_change` 로그 1건 생성.
   - **EventBus**: `STRATEGY_MODE_CHANGED` 발행, payload에 `mode`, `profile`, `thresholdEntry`, `minOrchestratorScore`, `updatedBy`, `updatedAt` 포함.

**실패 시**: api-server의 POST `/api/strategy-mode` 핸들러에서 AuditLogService.log, EventBus.emit 호출 확인.

---

### 시나리오 5: Explain 로그 검증

1. 모드를 **SAFE → A_BALANCED** 로 한 번 변경.
2. 엔진이 수십 초~몇 분 동작하게 둔 뒤, Dashboard Execution Log 또는 **GET** `/api/strategy-explain-recent` 로 최근 10~20건 확인.
3. 확인 항목:
   - `runtime_mode`, `mode_profile_snapshot`, `threshold_entry`, `min_orchestrator_score`, `skip_reason`, `reason_summary` 존재.
   - `skip_reason` = `score_below_threshold` 인 건이 있으면 해당 건에 위 필드가 채워져 있는지 확인.
   - (선택) p0 탈락 구간이 있으면 `skip_reason` = `p0_gate_blocked` 인 Explain 로그 존재.

**실패 시**: orchestrator / scalpSignalProvider 쪽 explainLogger.log 호출 및 payload 필드 확인.

---

## 2. 5개 통과 후 바로 진행: SAFE 30분 vs A_BALANCED 30분 비교

- **목적**: 동일 환경에서 SAFE 30분 / A_BALANCED 30분 각각 돌려서 거래 수·스킵 사유 분포 비교.

### 2-1. SAFE 30분

1. **GET** `/api/strategy-config` 로 현재 모드 확인.
2. **POST** `/api/strategy-mode`  
   Body: `{ "mode": "SAFE", "updatedBy": "dashboard" }`  
   → threshold 0.62 적용.
3. 시작 시각 기록. **30분 동안** 엔진 가동 유지.
4. (선택) 30분 후 **GET** `/api/strategy-status` 로 `tradeCountLast30m`, `decisionCountLast30m`, `skipTop5` 저장 또는 스크린샷.

### 2-2. A_BALANCED 30분

1. **POST** `/api/strategy-mode`  
   Body: `{ "mode": "A_BALANCED", "updatedBy": "dashboard" }`  
   → threshold 0.38 적용.
2. 시작 시각 기록. **30분 동안** 엔진 가동 유지.
3. (선택) 30분 후 **GET** `/api/strategy-status` 로 동일 항목 저장.

### 2-3. 비교 포인트

- 30분당 **거래 수** (trade count) 차이.
- **skip reason 상위** (score_below_threshold 비율 감소 여부).
- Explain 로그에서 **score_below_threshold** vs 기타 스킵 비율.

---

## 3. 요약

- **구동 준비**: 위 5개 시나리오만 통과하면 구동 가능 상태.
- **구현 유지**: p0_gate_blocked 로그, ORCHESTRATOR deprecated 정리 그대로 유지, 추가 리팩터링 없음.
- **비교 운영**: 5개 통과 후 SAFE 30분 → A_BALANCED 30분 순서로 진행하면 됨.
