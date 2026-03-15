# MyScalpBot / MarketSearchEngine — 운영형 아키텍처 최종 설계안

시니어 Node.js 아키텍트·Discord Bot·자동매매 리팩터링 관점의 **실전형** 설계안입니다.  
Node.js + TypeScript + discord.js + Express/Fastify + PM2 기준, Windows 미니PC 단독 운영을 전제로 합니다.

---

## 1) 현재 구조의 핵심 문제점 요약

### 보안
- **단일 관리자 ID만 검사**: 역할/채널/명령별 세분화 없음. MarketSearchEngine은 관리자 검사 없음.
- **위험 명령 1클릭 실행**: engine_stop, sell_all 등 즉시 실행되어 오작동·피로 시 복구 불가.
- **Rate limit 없음**: 버튼/API 남발 시 Upbit·Gemini 한도 초과·IP 제한 위험.
- **환경변수 검증 부재**: 부팅 시 필수 키·채널 ID 검증 없이 부분 실패만 로그.

### 성능
- **중복 수집**: AI 자동 분석·데이터 복사·시황 요약이 각각 상위 5~30 종목을 따로 조회. RSI/체결강도/5분봉 반복 호출.
- **캐시 없음**: 매 요청마다 Upbit/Gemini/외부 API 직접 호출. 대시보드 emit 시에도 fetchAssets 매번 실행 가능.
- **병목 혼재**: server.js 한 프로세스에서 HTTP + Socket + 매매 루프 + Discord + 스케줄이 함께 돌아 단일 장애점.

### 유지보수성
- **server.js 과다 책임**: 라우트·핸들러·도메인 로직·Upbit/Gemini 호출·상태 관리가 한 파일에 집중.
- **응답 포맷 불일치**: Discord Embed vs 웹 JSON vs API JSON 구조가 제각각. 수익률 계산도 클라이언트 fallback 존재.
- **계산 로직 분산**: 수익률·자산 요약이 discordBot 쪽 핸들러와 emitDashboard·upbit.summarizeAccounts에 흩어져 있음.

### UX
- **버튼만 존재**: slash command 없어 검색·파라미터 지정 불가. “빠른 실행”과 “상세 조회” 구분 없음.
- **Embed 메타정보 부족**: 기준 시각·데이터 범위·모델명·종목 수·경고 문구 없음. 오류 시 “오류: …” 수준만 표시.
- **헬스체크가 단순 DM**: “가즈아”/“영!차!”만으로는 프로세스·에러·마지막 주문 시각 등 운영 판단 불가.

### 운영성
- **장애 코드 체계 없음**: Discord/Upbit/Gemini/Network/Auth 별 코드 없이 메시지 문자열만 로그.
- **감사 로그 없음**: 누가 어떤 명령을 언제 실행했는지, 2단계 승인 여부, 주문 발생 여부가 남지 않음.
- **재연결 고정 30초**: 지수 백오프 없이 30초만 반복 시 Discord/Upbit 제한에 걸리기 쉬움.
- **정전/재부팅 후 수동 복구**: PM2 resurrect는 작업 스케줄러에 의존하며, 프로세스별 상태 검증·자동 복구 로직 없음.

---

## 2) 목표 아키텍처 제안

### 전체 디렉터리 구조

```
upbit-price-alert/
├── apps/
│   ├── api-server/          # HTTP + Socket.IO, 대시보드·API·웹 정적
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── routes/
│   │   │   ├── socket/
│   │   │   └── config.ts
│   │   └── package.json
│   ├── trading-engine/      # 매매 사이클, 스냅샷, 진입/청산 판단 (Upbit 호출 포함)
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── scalp/
│   │   │   └── config.ts
│   │   └── package.json
│   ├── discord-operator/     # MyScalpBot — 제어·체결 알림·헬스 DM
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── commands/
│   │   │   ├── handlers/
│   │   │   └── config.ts
│   │   └── package.json
│   └── market-bot/           # MarketSearchEngine — 시황 조회 전용
│       ├── src/
│       │   ├── index.ts
│       │   ├── commands/
│       │   └── config.ts
│       └── package.json
├── packages/
│   ├── core/                 # 도메인 서비스 (계산·스냅샷·포트폴리오·감사·헬스·권한)
│   │   ├── src/
│   │   │   ├── services/
│   │   │   │   ├── MarketSnapshotService.ts
│   │   │   │   ├── PortfolioService.ts
│   │   │   │   ├── ProfitCalculationService.ts
│   │   │   │   ├── PermissionService.ts
│   │   │   │   ├── AuditLogService.ts
│   │   │   │   ├── HealthReportService.ts
│   │   │   │   └── GeminiAnalysisService.ts
│   │   │   └── index.ts
│   │   └── package.json
│   └── shared/               # 타입·에러코드·상수·유틸
│       ├── src/
│       │   ├── types/
│       │   ├── errors/
│       │   ├── constants/
│       │   └── index.ts
│       └── package.json
├── adapters/                 # 외부 연동 (선택: monorepo 내부 또는 packages/shared 하위)
│   ├── upbit/
│   ├── discord/
│   └── gemini/
├── ecosystem.config.cjs
├── package.json              # workspace root
└── docs/
```

- **단일 repo + workspace** 로 두고, 초기에는 `apps`를 기존 `server.js`/`market_search.js`를 단계적으로 나누는 진입점으로 사용.
- `packages/core`에서 **ProfitCalculationService** 단일 소스로 수익률·자산 요약 제공 → Discord/웹/API는 모두 이 결과만 사용 (프론트 fallback 제거).

### 각 모듈 책임

| 모듈 | 책임 |
|------|------|
| **api-server** | Express/Fastify 라우트, Socket.IO emit, 정적 파일, `/api/analyst/*` 등 HTTP API. **계산은 하지 않고** core 서비스 호출만. |
| **trading-engine** | 1초 주기 스냅샷, scalpEngine 로직, 주문 실행. Upbit 호출·state.botEnabled 관리. core의 PortfolioService·ProfitCalculationService 사용. |
| **discord-operator** | MyScalpBot: slash/버튼 수신, PermissionService 검사, 2단계 확인, core 서비스 호출, 체결 알림·헬스 DM 전송. |
| **market-bot** | MarketSearchEngine: 시황 버튼/slash, **채널 allowlist + analyst 이상 권한** 검사, DASHBOARD_URL 대신 **api-server URL** 호출. |
| **packages/core** | MarketSnapshotService, PortfolioService, **ProfitCalculationService**(단일), PermissionService, AuditLogService, HealthReportService, GeminiAnalysisService. |
| **packages/shared** | AppResult, AppErrorCode, PermissionLevel, HealthStatus, 공통 상수. |

### 프로세스 경계

```
[PM2]
  api-server     (port 3000)  ← 웹·Socket·REST
  trading-engine (내부만, 또는 api-server와 같은 프로세스에서 worker로 분리 가능)
  discord-operator (Discord 1 Client)
  market-bot     (Discord 1 Client)

데이터 흐름:
  trading-engine --(state/주문 결과)--> api-server (Socket emit)
  api-server --(HTTP)--> core 서비스
  discord-operator --(HTTP 또는 직접 core 호출)--> api-server 또는 core
  market-bot --(HTTP)--> api-server /api/analyst/*
  모든 수익률/자산 표시 <-- ProfitCalculationService (단일 소스)
```

- **1단계 리팩터**에서는 trading-engine을 server.js 내부 모듈로 분리해도 됨. 2단계에서 프로세스 분리 가능.

---

## 3) 단계별 리팩터링 로드맵

### 1단계: 안전성 확보 (4~6주)

| 작업 | 내용 | 기대 효과 | 리스크 |
|------|------|-----------|--------|
| 환경변수 검증 | 부팅 시 필수 키·채널 ID·ADMIN_ID 검증, 누락 시 명확한 로그 후 종료 | 부분 기동 방지 | 없음 |
| 다층 권한 도입 | shared에 PermissionLevel, core에 PermissionService. superAdmin/admin/analyst/viewer 정의 | 명령별 접근 제어 | 기존 .env ADMIN_ID를 superAdmin 1명으로 매핑 필요 |
| 위험 명령 2단계 확인 | sell_all, engine_stop에 확인 버튼·토큰·타임아웃 | 오작동 방지 | UX 일시적 복잡도 |
| Rate limit | Discord interaction별·사용자별 분당 N회 제한 (메모리 또는 Redis) | API 남발 방지 | Redis 없으면 메모리만 사용 |
| 감사 로그 저장 | 누가/언제/무엇/성공·실패/원인코드 저장. SQLite JSONL 또는 단일 SQLite 테이블 | 운영·사후 추적 | 디스크 사용량 |

### 2단계: 구조 분리 (6~8주)

| 작업 | 내용 | 기대 효과 | 리스크 |
|------|------|-----------|--------|
| server.js 책임 분리 | 라우트·Socket·매매 루프·Discord 핸들러를 폴더별 모듈로 분리 (아직 1프로세스) | 가독성·테스트 용이 | 기존 동작 유지 회귀 테스트 필요 |
| ProfitCalculationService 단일화 | 수익률·자산 요약을 core 한 곳에서만 계산. Discord/웹/emit은 모두 이 결과만 사용 | 수익률 오차 0, fallback 제거 | 기존 summarizeAccounts 호출부 전부 대체 |
| 공통 응답 포맷 | AppResult&lt;T&gt;, AppErrorCode. Discord Embed/웹/API가 같은 도메인 DTO 사용 | 일관된 에러·데이터 구조 | Embed 빌더에서 DTO → Embed 변환 레이어 필요 |
| 채널 allowlist | PermissionService에서 채널 ID allowlist 검사 (MarketSearchEngine 포함) | 채널 오용 방지 | 설정 스키마 추가 |

### 3단계: 성능 최적화 (4~6주)

| 작업 | 내용 | 기대 효과 | 리스크 |
|------|------|-----------|--------|
| 캐시 계층 도입 | 상위 종목·RSI/체결강도/5분봉·FNG·계좌 요약 TTL 캐시 (메모리 또는 Redis) | API 호출·중복 수집 감소 | 캐시 무효화 타이밍 설계 |
| 중복 수집 제거 | Analyst용 데이터를 MarketSnapshotService 한 번 수집 후 캐시, AI 자동 분석/데이터 복사/시황이 공유 | 지표 API 호출 최소화 | 데이터 신선도 트레이드오프 |
| 지수 백오프 재연결 | Discord/Upbit 재연결 시 30→60→120→300초, 최대치 제한 | rate limit 회피 | 재연결 지연 증가 |

### 4단계: UX/운영 고도화 (4~6주)

| 작업 | 내용 | 기대 효과 | 리스크 |
|------|------|-----------|--------|
| Slash command 도입 | /engine start|stop, /sell all, /status, /pnl, /analyst scan-vol|summary|indicators | 검색·일관된 UX | discord.js v13→슬래시 지원 확인 |
| 버튼는 “빠른 실행 패널”만 | 상세 조회·파라미터 지정은 slash로 이관 | 역할 명확화 | 기존 버튼 사용자 적응 |
| Embed 메타정보 | 기준 시각, 데이터 범위, 모델명, 종목 수, 경고 문구, 장애 시 원인 코드 | 신뢰도·디버깅 | Embed 필드 수 증가 |
| 헬스체크 운영 리포트 | DM을 Embed 리포트로: 프로세스·마지막 주문·에러 수·Gemini 실패·Upbit·Discord·emit 시각·리소스 | 운영 가시성 | 수집 지표 구현 비용 |
| Gemini 프롬프트 개선 | “즉시 1% 수익” 축소, 신호 강도/근거/무효화 조건/리스크 중심, 실패 시 fallback | 규제·안정성 | 응답 스타일 변경 |

---

## 4) 실제 코드베이스에 바로 반영 가능한 폴더 구조 예시 (TypeScript)

```
dashboard/   (또는 upbit-price-alert 루트)
├── src/
│   ├── apps/
│   │   ├── api-server/
│   │   │   ├── index.ts
│   │   │   ├── routes/
│   │   │   │   ├── analyst.ts
│   │   │   │   ├── health.ts
│   │   │   │   └── index.ts
│   │   │   ├── socket/
│   │   │   │   └── dashboard.ts
│   │   │   └── config.ts
│   │   ├── trading-engine/
│   │   │   ├── index.ts
│   │   │   ├── scalp/
│   │   │   │   ├── cycle.ts
│   │   │   │   └── executor.ts
│   │   │   └── config.ts
│   │   ├── discord-operator/
│   │   │   ├── index.ts
│   │   │   ├── commands/
│   │   │   │   ├── engine.ts
│   │   │   │   ├── status.ts
│   │   │   │   ├── pnl.ts
│   │   │   │   └── analyst.ts
│   │   │   ├── handlers/
│   │   │   │   ├── buttons.ts
│   │   │   │   └── confirm.ts
│   │   │   └── config.ts
│   │   └── market-bot/
│   │       ├── index.ts
│   │       ├── commands/
│   │       │   └── analyst.ts
│   │       └── config.ts
│   ├── modules/
│   │   ├── permission/
│   │   │   ├── PermissionService.ts
│   │   │   ├── types.ts
│   │   │   └── index.ts
│   │   ├── audit/
│   │   │   ├── AuditLogService.ts
│   │   │   └── index.ts
│   │   └── health/
│   │       ├── HealthReportService.ts
│   │       └── index.ts
│   ├── services/
│   │   ├── MarketSnapshotService.ts
│   │   ├── PortfolioService.ts
│   │   ├── ProfitCalculationService.ts
│   │   └── GeminiAnalysisService.ts
│   ├── adapters/
│   │   ├── upbit/
│   │   │   ├── client.ts
│   │   │   └── summarizeAccounts.ts
│   │   ├── discord/
│   │   │   ├── embed.ts
│   │   │   └── rateLimit.ts
│   │   └── gemini/
│   │       └── client.ts
│   └── shared/
│       ├── types/
│       │   ├── AppResult.ts
│       │   ├── PermissionContext.ts
│       │   ├── HealthStatus.ts
│       │   └── AnalysisSnapshot.ts
│       ├── errors/
│       │   ├── AppErrorCode.ts
│       │   └── createError.ts
│       └── constants/
│           └── index.ts
├── lib/          # 기존 CommonJS 유지 시 여기서 점진적 이전
├── ecosystem.config.cjs
├── package.json
└── tsconfig.json
```

- **실제 반영 시**: 기존 `server.js`는 `src/apps/api-server` + `trading-engine`으로 분할하고, `lib/`는 `adapters/`·`services/`로 단계 이전. TypeScript는 `tsconfig`로 점진적 도입 가능.

---

## 5) 공통 타입/에러 코드/응답 포맷 예시

### AppResult&lt;T&gt;

```ts
// shared/types/AppResult.ts
type AppResult<T> =
  | { ok: true; data: T; meta?: { cachedAt?: number; source?: string } }
  | { ok: false; error: AppError; meta?: { code: AppErrorCode } };

interface AppError {
  code: AppErrorCode;
  message: string;
  details?: string;
  guide?: string;  // 사용자용 가이드 링크 또는 문구
}
```

### AppErrorCode

```ts
// shared/errors/AppErrorCode.ts
enum AppErrorCode {
  // Auth
  UNAUTHORIZED = 'AUTH_UNAUTHORIZED',
  INSUFFICIENT_ROLE = 'AUTH_INSUFFICIENT_ROLE',
  CHANNEL_NOT_ALLOWED = 'AUTH_CHANNEL_NOT_ALLOWED',
  RATE_LIMIT_EXCEEDED = 'AUTH_RATE_LIMIT_EXCEEDED',
  CONFIRMATION_EXPIRED = 'AUTH_CONFIRMATION_EXPIRED',
  CONFIRMATION_REJECTED = 'AUTH_CONFIRMATION_REJECTED',

  // Upbit
  UPBIT_AUTH_FAILED = 'UPBIT_AUTH_FAILED',
  UPBIT_RATE_LIMIT = 'UPBIT_RATE_LIMIT',
  UPBIT_ORDER_FAILED = 'UPBIT_ORDER_FAILED',
  UPBIT_NETWORK = 'UPBIT_NETWORK',

  // Gemini
  GEMINI_UNAVAILABLE = 'GEMINI_UNAVAILABLE',
  GEMINI_QUOTA = 'GEMINI_QUOTA',
  GEMINI_INVALID_RESPONSE = 'GEMINI_INVALID_RESPONSE',

  // Discord
  DISCORD_NOT_READY = 'DISCORD_NOT_READY',
  DISCORD_SEND_FAILED = 'DISCORD_SEND_FAILED',

  // Data
  DATA_STALE = 'DATA_STALE',
  DATA_MISSING = 'DATA_MISSING',

  // Generic
  INTERNAL = 'INTERNAL',
  CONFIG_MISSING = 'CONFIG_MISSING',
}
```

### PermissionContext

```ts
// shared/types/PermissionContext.ts
enum PermissionLevel {
  SUPER_ADMIN = 4,
  ADMIN = 3,
  ANALYST = 2,
  VIEWER = 1,
  NONE = 0,
}

interface PermissionContext {
  userId: string;
  channelId: string;
  role?: PermissionLevel;  // 디스코드 역할 기반이 있으면
  level: PermissionLevel;   // 최종 적용 레벨
  allowedChannels: string[];
}
```

### HealthStatus

```ts
// shared/types/HealthStatus.ts
interface HealthStatus {
  process: 'api-server' | 'trading-engine' | 'discord-operator' | 'market-bot';
  uptimeSec: number;
  lastOrderAt: string | null;   // ISO
  errorsLast1h: number;
  geminiFailuresLast1h: number;
  upbitAuthOk: boolean;
  discordConnected: boolean;
  lastEmitAt: string | null;    // ISO
  memoryMb?: number;
  cpuPercent?: number;
  reportedAt: string;           // ISO
}
```

### AnalysisSnapshot (Embed/API 공통)

```ts
// shared/types/AnalysisSnapshot.ts
interface AnalysisSnapshot {
  at: string;                  // ISO 기준 시각
  symbolCount: number;
  dataRange: string;            // e.g. "거래대금 상위 5종목"
  model?: string;              // e.g. "gemini-2.5-flash"
  warning?: string;
  errorCode?: AppErrorCode;
  payload: Record<string, unknown>;  // Embed 필드·수익률 등
}
```

---

## 6) 위험 명령 2단계 확인 흐름 예시 (Discord interaction)

```
위험 명령 정의: customId IN ["engine_stop", "sell_all"] (또는 slash /engine stop, /sell all)

ON 버튼 클릭 (또는 slash 실행):
  ctx = PermissionContext.from(interaction)
  IF PermissionService.can(ctx, "engine_stop" | "sell_all") === false THEN
    reply ephemeral { content: "권한 없음", errorCode: INSUFFICIENT_ROLE }
    AuditLogService.log({ action: "danger_denied", userId, command, reason: "role" })
    RETURN
  END IF

  confirmToken = generateSecureToken(16)   // 5분 TTL
  state.pendingConfirm[confirmToken] = { userId, command: "engine_stop"|"sell_all", expiresAt: now + 5min }

  reply ephemeral {
    content: "⚠️ [즉시 정지] 실행 시 매매가 중단되고 미체결 주문이 모두 취소됩니다. 계속하려면 아래 [확인]을 누르세요.",
    components: [ ActionRow([
      Button(customId: "confirm_" + confirmToken, label: "확인", style: DANGER),
      Button(customId: "cancel_" + confirmToken, label: "취소", style: SECONDARY)
    ])]
  }
  RETURN

ON "confirm_" + token 버튼 클릭:
  pending = state.pendingConfirm[token]
  IF NOT pending OR pending.userId !== interaction.user.id THEN
    reply ephemeral { content: "본인만 확인할 수 있습니다.", errorCode: AUTH_CONFIRMATION_REJECTED }
    RETURN
  END IF
  IF now > pending.expiresAt THEN
    delete state.pendingConfirm[token]
    reply ephemeral { content: "확인 시간이 지났습니다. 다시 시도하세요.", errorCode: AUTH_CONFIRMATION_EXPIRED }
    RETURN
  END IF

  delete state.pendingConfirm[token]
  AuditLogService.log({ action: pending.command, userId, approved: true })

  IF pending.command === "engine_stop" THEN handlers.engineStop()
  ELSE IF pending.command === "sell_all" THEN handlers.sellAll()
  END IF

  reply ephemeral { content: "실행 완료." }
  RETURN

ON "cancel_" + token 버튼 클릭:
  delete state.pendingConfirm[token]
  AuditLogService.log({ action: pending.command, userId, approved: false })
  reply ephemeral { content: "취소되었습니다." }
  RETURN
```

---

## 7) 캐시 전략 표

| 데이터 종류 | TTL | 무효화 조건 | fallback 처리 |
|-------------|-----|-------------|----------------|
| 상위 거래대금 종목 목록 | 10초 | 수동 무효화 없음 | TTL 만료 시 재조회, 실패 시 이전 캐시 유지(표시 시 "데이터 지연" 경고) |
| RSI/체결강도/5분봉 (종목별) | 15초 | 해당 종목 체결/주문 시 해당 종목만 무효화 | 동일 |
| FNG / BTC 추세 / 김프 | 60초 | 없음 | 동일 |
| 시황 요약용 집계 (상위 30 비율 등) | 30초 | 없음 | 동일 |
| 계좌 요약 / 총자산 / 수익률 | 5초 | 주문 체결·취소·엔진 시작/정지 시 즉시 무효화 | 5초 이내 요청은 캐시 반환, 무효화 시 다음 요청에서 재계산 |
| Gemini 스캘핑 타점 분석 결과 | 60초 (같은 데이터 해시 기준) | 데이터 해시 변경 시 새 요청 | Gemini 실패 시 "분석 일시 불가" + errorCode, 이전 결과 재사용 안 함 |

- **저장소**: 단일 프로세스면 메모리(Map + TTL). api-server와 trading-engine 분리 시 Redis 권장.

### 감사 로그 저장소 권장 (JSONL vs SQLite vs PostgreSQL)

| 저장소 | 적합한 경우 | 장점 | 단점 |
|--------|-------------|------|------|
| **SQLite** | 단일 프로세스·미니PC·Windows, 1개 앱만 로그 쓰기 | 설정 없음, 파일 하나, 쿼리·보관 기간 정리 용이, PM2 재시작에도 유지 | 동시 다중 프로세스 쓰기 시 lock |
| **JSONL** | 최소 구현·디버깅용, 로그만 순차 기록 | 구현 간단, tail로 실시간 확인 | 조회·필터·보관 기간 정리 수동, 대용량 시 비효율 |
| **PostgreSQL** | 다중 앱·다중 서버·장기 보관·복잡 쿼리 필요 시 | 동시 쓰기·인덱스·백업·확장에 유리 | 설치·운영 부담, 미니PC 단독에는 과할 수 있음 |

**결론**: 현재 구조(server.js + market_search.js 2프로세스, Windows 미니PC)에서는 **SQLite 단일 테이블** 권장. 감사 로그는 주로 discord-operator에서만 쓰므로 한 프로세스가 쓰기 담당이면 충돌 없음. 나중에 api-server/trading-engine 분리 후 여러 프로세스가 같은 DB에 쓸 경우에도 SQLite는 읽기 다수·쓰기 단일이면 무리 없음. PostgreSQL은 팀 확장·다중 서버로 갈 때 도입 검토.
- **ProfitCalculationService**: 계좌 요약 캐시를 소비하며, **항상 동일 공식**으로 계산해 반환. 디스코드/웹은 이 값만 사용.

---

## 8) 헬스체크 리포트 예시 (Discord Embed)

```
제목: "🟢 운영 리포트 — 2025-03-06 14:00 KST"
색상: 0x57f287 (정상) / 0xed4245 (경고)

필드:
  [프로세스]     api-server, discord-operator, market-bot (각각 상태: 온라인/오프라인)
  [가동 시간]    Uptime 3d 2h
  [마지막 주문]  2025-03-06 13:58 (또는 "없음")
  [최근 1h 에러] 0 (또는 숫자)
  [Gemini 실패]  0
  [Upbit 인증]   정상 / 만료
  [Discord]     연결됨 / 끊김
  [마지막 emit] 2025-03-06 13:59:58
  [메모리]      85 MB (선택)
  [CPU]         2% (선택)

Footer: "1시간마다 발송 · 관리자 전용"
Timestamp: now
```

- **발송**: 1시간마다 관리자 DM에 위 Embed 전송. 데이터는 HealthReportService가 api-server·trading-engine·자체 상태에서 수집 (HTTP 헬스 엔드포인트 또는 공유 DB/캐시).

---

## 9) Gemini 프롬프트 개선안

- **원칙**: 매매 결정권은 규칙 엔진에 두고, Gemini는 “해설·신호 해석·리스크 요약”만 담당. “지금 사라” 식 표현 축소.

### scan-vol (급등주 분석)

```
기존: "가장 유력한 급등 후보 1종목만 선정"

개선:
"아래 업비트 실시간 데이터(상위 10종목)를 참고만 해줘.

다음 4가지만 짧게 출력해. 다른 말 없이.

1) 현재 신호가 상대적으로 강한 1종목과 그 이유 (RSI·체결강도·거래량 기준, 1~2문장).
2) 기술적 근거 (지표 수치 언급).
3) 무효화 조건: 어떤 상황이 되면 이 신호가 무의미해지는지 1문장.
4) 리스크: 단기 조정·과매수·유동성 등 1문장.

※ 최종 매매 여부는 사용자 판단이며, 본 분석은 참고용입니다.

데이터:
{dataText}"
```

### market-summary (시황 요약)

```
기존: "추천 종목 1개"

개선:
"아래 한국 암호화폐 시장 데이터를 요약만 해줘. 3문단만 출력.

1문단: 비트코인·글로벌 흐름과 공포·탐욕 지수 요약.
2문단: 거래량 상위 중 지표상 관심 구간 1종목과 근거(참고용). '추천 매수'가 아닌 '관심 구간' 표현만 사용.
3문단: 단기 대응 시 유의할 점 3줄 (리스크·무효화 조건 포함).

※ 매매 결정은 사용자 책임입니다.

데이터:
{ctx}"
```

### scalp-point (AI 자동 분석)

```
기존: "지금 즉시 1% 수익 가능한 스캘핑 타점과 추천 종목을 알려줘"

개선:
"아래 RSI·체결강도·5분봉 데이터는 참고용입니다.

3문단 이내로만 답변해줘.

1) 현재 데이터 상에서 스캘핑 관점으로 신호가 상대적으로 나온 1종목과 그 이유 (지표 기준).
2) 진입 시 무효화 조건 (예: RSI 역전, 체결강도 하락 등).
3) 실패 시나리오와 리스크 1문장.

※ 수익을 보장하지 않으며, 최종 매매는 사용자 판단입니다.

데이터:
{dataText}"
```

- **Graceful fallback**: Gemini 호출 실패 시 `GEMINI_UNAVAILABLE` 등 코드와 함께 “분석 일시 불가. 잠시 후 재시도하세요.” + 가이드 링크. 이전 캐시 결과를 “추천”으로 재사용하지 않음.

---

## 10) 실행 체크리스트 (구현 순서)

1. **환경변수 검증**  
   - 부팅 시 `DISCORD_TOKEN`, `CHANNEL_ID`, `ADMIN_ID`, `UPBIT_*`, `GEMINI_API_KEY` 등 필수 항목 검사.  
   - 누락 시 로그 출력 후 `process.exit(1)`.

2. **shared 타입·에러 코드**  
   - `AppResult<T>`, `AppErrorCode`, `PermissionLevel` 정의.  
   - API/디스코드 응답에서 동일 코드 사용.

3. **ProfitCalculationService 단일화**  
   - `summarizeAccounts` + 수익률 공식을 한 서비스로 이전.  
   - Discord current_state/current_return, emitDashboard, 웹 클라이언트가 모두 이 서비스 결과만 사용.  
   - 프론트 fallback 수익률 계산 제거.

4. **PermissionService + 2단계 확인**  
   - superAdmin/admin/analyst/viewer 정의.  
   - engine_stop, sell_all에만 2단계 확인 플로우 적용 (토큰·5분 TTL·감사 로그).

5. **감사 로그 저장**  
   - SQLite 테이블 또는 JSONL: userId, command, at, success, errorCode, approved(위험 명령 시).  
   - 최소 30일 보관.

6. **Rate limit**  
   - Discord interaction별 사용자당 분당 10~20회 제한 (메모리 Map + 슬라이딩 윈도우 또는 간단 카운터).

7. **캐시 계층**  
   - 상위 종목·RSI/체결강도/계좌 요약 TTL 캐시 도입.  
   - Analyst 핸들러는 캐시 우선, 무효화 시에만 재조회.

8. **Discord 재연결 지수 백오프**  
   - 30 → 60 → 120 → 300초, 최대 300초로 제한.

9. **헬스체크 운영 리포트**  
   - 1시간마다 관리자 DM에 Embed (프로세스·마지막 주문·에러 수·Upbit·Discord·emit 시각).

10. **Slash command 등록**  
    - /engine start|stop, /status, /pnl, /analyst scan-vol|summary|indicators.  
    - 버튼는 “빠른 실행 패널”만 유지.

11. **Embed 메타정보**  
    - 모든 분석/수익률 Embed에 기준 시각, 데이터 범위, 모델명, 종목 수, 필요 시 경고·errorCode.

12. **Gemini 프롬프트 교체**  
    - scan-vol, market-summary, scalp-point를 위 “개선안”으로 교체.  
    - 실패 시 fallback 메시지 + errorCode.

13. **채널 allowlist**  
    - PermissionService에서 채널 ID allowlist 검사 (MarketSearchEngine 포함).

14. **server.js 분리**  
    - 라우트/핸들러/매매 루프/디스코드 모듈 분리.  
    - 필요 시 TypeScript로 점진 이전.

15. **PM2·로그·재부팅**  
    - ecosystem.config.cjs에 재시작 전략·로그 경로 명시.  
    - Windows 작업 스케줄러 + pm2 resurrect 문서화.  
    - Linux 전환 시 systemd 권장 한 줄 안내.

---

## Top 5 우선순위 (가장 먼저 수정할 항목)

1. **ProfitCalculationService 단일화 + 수익률 공식 일원화**  
   - 디스코드/웹/emit이 한 서비스 결과만 쓰고, 프론트 fallback 제거.  
   - 운영 신뢰도와 “수익률 오차 0” 확정.

2. **위험 명령(engine_stop, sell_all) 2단계 확인**  
   - 확인 토큰·5분 TTL·감사 로그까지 함께 도입.  
   - 오작동·피로 시 복구 비용을 줄이는 최우선 보안 조치.

3. **환경변수 검증 + AppErrorCode 체계**  
   - 부팅 시 검증으로 부분 기동 방지.  
   - 에러 코드로 운영·로그·가이드 연동 기반 마련.

4. **감사 로그 저장 (누가/언제/무엇/성공·실패/승인 여부)**  
   - SQLite 단일 테이블로 시작.  
   - 사후 추적·권한 남용 확인 가능.

5. **Discord 재연결 지수 백오프 + 헬스체크를 운영 리포트 Embed로 변경**  
   - 30초 고정 제거로 rate limit 리스크 감소.  
   - “가즈아/영!차!” 대신 프로세스·에러·마지막 주문 시각 등 운영 판단에 쓸 수 있는 정보 제공.

---

*문서 끝. Windows 미니PC 단독 운영 시 리소스 제한을 고려해 Redis는 선택으로 두고, 1단계에서는 메모리 캐시·SQLite만으로 진행해도 무방하다. Linux 전환 시 systemd + PM2 조합으로 자동 복구를 더 단순하게 구성할 수 있다.*
