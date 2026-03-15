# MyScalpBot / MarketSearchEngine — 운영형 설계 명세 (코드 생성용)

**기술 스택**: Node.js, TypeScript, discord.js, Express 또는 Fastify, PM2  
**운영 환경**: Windows 미니PC, 단일 서버, 24시간 실행, Discord 기반

---

## 1. 디렉터리 구조

```
dashboard/   (또는 upbit-price-alert 루트)
├── src/
│   ├── apps/
│   │   ├── api-server/
│   │   │   ├── index.ts              # Express/Fastify + Socket.IO 진입
│   │   │   ├── routes/
│   │   │   │   ├── analyst.ts        # GET /api/analyst/scan-vol, summary, indicators
│   │   │   │   ├── health.ts         # GET /api/health
│   │   │   │   └── index.ts
│   │   │   ├── socket/
│   │   │   │   └── dashboard.ts      # io.on('connection'), emit 'dashboard'
│   │   │   └── config.ts
│   │   ├── trading-engine/
│   │   │   ├── index.ts              # setInterval(runCycle, 1000), fetchAssets, runScalpCycle
│   │   │   ├── scalp/
│   │   │   │   ├── cycle.ts          # runScalpCycle()
│   │   │   │   └── executor.ts       # placeMarketBuyByPrice, placeMarketSellByVolume
│   │   │   └── config.ts
│   │   ├── discord-operator/
│   │   │   ├── index.ts              # Client login, interactionCreate, ready
│   │   │   ├── commands/
│   │   │   │   ├── engine.ts         # /engine start, /engine stop
│   │   │   │   ├── status.ts         # /status
│   │   │   │   ├── pnl.ts            # /pnl
│   │   │   │   └── analyst.ts        # /analyst scan-vol, summary, indicators
│   │   │   ├── handlers/
│   │   │   │   ├── buttons.ts        # 버튼 customId → handler 매핑
│   │   │   │   └── confirm.ts        # 2단계 확인 confirm_*, cancel_*
│   │   │   └── config.ts
│   │   └── market-bot/
│   │       ├── index.ts              # 별도 Client, 시황 버튼만
│   │       ├── commands/
│   │       │   └── analyst.ts        # DASHBOARD_URL/api/analyst/* 호출
│   │       └── config.ts
│   ├── core/
│   │   ├── EventBus.ts               # 단일 채널 emit/on, 타입별 핸들러
│   │   ├── EngineState.ts            # botEnabled, lastOrderAt, assets, scalpState
│   │   ├── CircuitBreaker.ts         # Upbit/Gemini/Discord 별 실패 카운트·OPEN/CLOSED
│   │   ├── services/
│   │   │   ├── ProfitCalculationService.ts
│   │   │   ├── MarketSnapshotService.ts
│   │   │   ├── AuditLogService.ts
│   │   │   └── HealthReportService.ts
│   │   └── cache/
│   │       └── TtlCache.ts           # Map + TTL, 무효화 키
│   ├── adapters/
│   │   ├── upbit.ts
│   │   ├── gemini.ts
│   │   └── discord.ts
│   └── shared/
│       ├── types.ts                  # AppResult<T>, EmbedPayload, PermissionLevel
│       ├── errors.ts                 # AppErrorCode
│       └── constants.ts
├── lib/                              # 기존 CommonJS (점진 이전)
├── ecosystem.config.cjs
├── package.json
└── tsconfig.json
```

---

## 2. 프로세스 구조 & 데이터 흐름

### 프로세스 구조 (PM2)

```
PM2 ecosystem.config.cjs:
  - api-server     (node dist/apps/api-server/index.js)  port 3000
  - trading-engine (node dist/apps/trading-engine/index.js)  내부만, 또는 api-server와 같은 프로세스
  - discord-operator (node dist/apps/discord-operator/index.js)  Discord 1 Client
  - market-bot     (node dist/apps/market-bot/index.js)  Discord 1 Client
```

- **단일 서버**: 위 4개 앱을 한 미니PC에서 실행. trading-engine은 1단계에서 api-server와 같은 프로세스 내 모듈로 둬도 됨.

### 데이터 흐름 (선형)

```
[Upbit WS] ──tick──> trading-engine ──state──> EventBus ──> api-server (Socket emit 'dashboard')
                                                      └──> discord-operator (status message 편집)

[Discord 버튼/슬래시] ──> discord-operator ──HTTP 또는 EventBus──> api-server /api/* 또는 core 서비스
                                                              └──> ProfitCalculationService.getSummary()

[market-bot 버튼] ──HTTP GET──> api-server /api/analyst/scan-vol|summary|indicators ──> core + Gemini
```

- 수익률/총자산: **항상** `ProfitCalculationService` 한 곳에서 계산 → api-server Socket payload, Discord Embed, /pnl 응답이 동일 값 사용.

---

## 3. EventBus 설계

### 이벤트 타입 (공통)

```ts
// shared/types.ts 또는 core/EventBus.ts
type EventType =
  | 'dashboard:emit'      // { lastEmit: DashboardPayload }
  | 'engine:state'       // { botEnabled: boolean }
  | 'order:filled'       // { market, side, price, quantity }
  | 'order:cancelAll'
  | 'audit:command'      // { userId, command, success, errorCode?, approved? }
  | 'health:tick';       // 1시간마다 리포트 수집용

interface EventPayloadMap {
  'dashboard:emit': { lastEmit: DashboardPayload };
  'engine:state': { botEnabled: boolean };
  'order:filled': { market: string; side: string; price: number; quantity: number };
  'order:cancelAll': Record<string, never>;
  'audit:command': { userId: string; command: string; success: boolean; errorCode?: string; approved?: boolean };
  'health:tick': void;
}
```

### 이벤트 흐름 (pseudo code)

```ts
// core/EventBus.ts
const listeners = new Map<EventType, Set<(payload: any) => void | Promise<void>>>();

function emit<T extends EventType>(type: T, payload: EventPayloadMap[T]): void {
  listeners.get(type)?.forEach((fn) => {
    Promise.resolve(fn(payload)).catch((e) => console.error('[EventBus]', type, e?.message));
  });
}

function on<T extends EventType>(type: T, fn: (payload: EventPayloadMap[T]) => void | Promise<void>): () => void {
  if (!listeners.has(type)) listeners.set(type, new Set());
  listeners.get(type)!.add(fn);
  return () => listeners.get(type)?.delete(fn);
}

// 사용 예: trading-engine에서 state 갱신 후
// EventBus.emit('dashboard:emit', { lastEmit: state.lastEmit });
// api-server가 EventBus.on('dashboard:emit', (p) => io.emit('dashboard', p.lastEmit));
// discord-operator가 EventBus.on('dashboard:emit', (p) => updateStatusMessage(buildEmbed(p.lastEmit)));
```

- **단일 프로세스**: EventBus는 in-memory. 다중 프로세스로 나눌 경우 Redis Pub/Sub 또는 동일 repo 내 IPC로 확장.

---

## 4. EngineState 설계

### 상태 구조

```ts
// core/EngineState.ts
interface EngineState {
  botEnabled: boolean;
  lastOrderAt: string | null;       // ISO
  assets: AssetSummary | null;      // totalEvaluationKrw, totalBuyKrw, orderableKrw (APENFT·PURSE 제외)
  scalpState: Record<string, ScalpMarketState>;
  lastEmit: DashboardPayload | null;
  strategySummary: StrategySummary | null;
  errorsLast1h: number;
  geminiFailuresLast1h: number;
  lastEmitAt: string | null;       // ISO
}

// 단일 소스: getState(), setState(partial), incrementError(), incrementGeminiFailure()
let state: EngineState = { ... };
export const getState = () => ({ ...state });
export const setState = (partial: Partial<EngineState>) => { state = { ...state, ...partial }; };
```

### 상태 변경 흐름

```
[엔진 가동]   /engine start  → setState({ botEnabled: true }); AuditLog.log('engine_start', ...)
[엔진 정지]   /engine stop   → setState({ botEnabled: false }); cancelAllOrders(); emit('order:cancelAll')
[체결 발생]   executor 완료  → setState({ lastOrderAt: new Date().toISOString() }); emit('order:filled')
[주기 틱]     setInterval    → fetchAssets → setState({ assets }); runScalpCycle → setState({ scalpState }); emit('dashboard:emit')
```

---

## 5. CircuitBreaker 설계

### 실패 기준

```ts
// core/CircuitBreaker.ts
const THRESHOLD = 5;           // 연속 실패 5회 시 OPEN
const HALF_OPEN_AFTER_MS = 60_000;  // 1분 후 한 번 시도

type State = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

interface Breaker {
  state: State;
  failures: number;
  lastFailureAt: number | null;
  lastSuccessAt: number | null;
}

// Upbit, Gemini, Discord(연결) 별로 각각 1개 인스턴스
const breakers = { upbit: createBreaker(), gemini: createBreaker(), discord: createBreaker() };
```

### 자동 보호 전략

```ts
function execute<T>(name: keyof typeof breakers, fn: () => Promise<T>): Promise<T> {
  const b = breakers[name];
  if (b.state === 'OPEN') {
    if (Date.now() - (b.lastFailureAt ?? 0) > HALF_OPEN_AFTER_MS) b.state = 'HALF_OPEN';
    else return Promise.reject(new Error(`CIRCUIT_OPEN_${name.toUpperCase()}`));
  }
  return fn()
    .then((r) => { b.failures = 0; b.lastSuccessAt = Date.now(); b.state = 'CLOSED'; return r; })
    .catch((e) => {
      b.failures++; b.lastFailureAt = Date.now();
      if (b.failures >= THRESHOLD) b.state = 'OPEN';
      throw e;
    });
}
```

- **사용**: Upbit 주문/잔고, Gemini generateContent, Discord send 시 `CircuitBreaker.execute('upbit', () => upbit.getAccounts(...))` 래핑. OPEN 시 즉시 실패·로그·Embed에 `errorCode: CIRCUIT_OPEN_UPBIT` 등 반환.

---

## 6. 캐시 전략

| 데이터 종류 | TTL(초) | 무효화 조건 | fallback |
|-------------|---------|-------------|----------|
| 상위 거래대금 종목 | 10 | 없음 | 이전 캐시 유지 + "데이터 지연" 표시 |
| RSI/체결강도/5분봉(종목별) | 15 | 해당 종목 주문/체결 시 해당 키만 삭제 | 이전 캐시 유지 |
| FNG / BTC 추세 / 김프 | 60 | 없음 | 이전 캐시 유지 |
| 계좌 요약 / 수익률 | 5 | 주문 체결·취소·engine start/stop 시 전체 무효화 | 재계산 (캐시 없으면 fetch) |
| Gemini 분석 결과 | 60 (입력 해시 기준) | 입력 해시 변경 시 | "분석 일시 불가" + errorCode, 이전 결과 재사용 안 함 |

```ts
// core/cache/TtlCache.ts
const store = new Map<string, { v: unknown; exp: number }>();
function get<T>(key: string): T | null {
  const e = store.get(key);
  if (!e || Date.now() > e.exp) { store.delete(key); return null; }
  return e.v as T;
}
function set<T>(key: string, value: T, ttlSec: number): void {
  store.set(key, { v: value, exp: Date.now() + ttlSec * 1000 });
}
function invalidate(keyOrPrefix: string): void {
  if (store.has(keyOrPrefix)) store.delete(keyOrPrefix);
  else for (const k of store.keys()) if (k.startsWith(keyOrPrefix)) store.delete(k);
}
```

---

## 7. Discord 명령 구조

| 명령 | 권한 | 동작 |
|------|------|------|
| `/engine start` | superAdmin, admin | EngineState.botEnabled = true, Upbit 인증 검사 |
| `/engine stop` | superAdmin, admin | 2단계 확인 후 botEnabled = false, cancelAllOrders |
| `/sell all` | superAdmin, admin | 2단계 확인 후 전량 시장가 매도 |
| `/status` | viewer 이상 | ProfitCalculationService 결과 + Gemini 1줄 + Embed(아래 형식) |
| `/pnl` | viewer 이상 | 수익률·총자산 Embed (동일 공식) |
| `/analyst scan-vol` | analyst 이상 | 상위 10종목 + Gemini 급등주 1줄 분석 Embed |
| `/analyst summary` | analyst 이상 | FNG·BTC·시황 + Gemini 3문단 Embed |
| `/analyst indicators` | analyst 이상 | 주요지표(김프·FNG·상위 종목) Embed |

- 버튼: "빠른 실행 패널"만 유지 (엔진 가동/정지, 현재 상태, 현재 수익률, AI 실시간 타점, 시황 요약, 급등주, 주요지표). 상세/파라미터는 슬래시로.

---

## 8. Embed 응답 형식 (반드시 포함)

모든 분석/수익률 Embed에 아래 필드를 포함한다.

```ts
// shared/types.ts
interface EmbedMeta {
  timestamp: string;    // ISO, 기준 시각
  model: string;        // e.g. "gemini-2.5-flash"
  dataRange: string;    // e.g. "거래대금 상위 5종목", "전체 계좌"
  symbolCount: number;  // 대상 종목 수 (해당 없으면 0)
  errorCode?: string;   // 실패 시 AppErrorCode (e.g. GEMINI_UNAVAILABLE)
  warning?: string;    // 선택, 경고 문구
}

// Embed 빌드 시
embed.setTimestamp(new Date(meta.timestamp));
embed.setFooter(`${meta.model} · ${meta.dataRange} · N=${meta.symbolCount}` + (meta.errorCode ? ` · ${meta.errorCode}` : ''));
if (meta.warning) embed.addFields({ name: '⚠️ 경고', value: meta.warning, inline: false });
```

- **예**: "gemini-2.5-flash · 거래대금 상위 5종목 · N=5" (정상), "gemini-2.5-flash · 거래대금 상위 5종목 · N=5 · GEMINI_UNAVAILABLE" (실패).

---

## 9. Gemini 프롬프트 개선안 (3개)

### scan-vol (급등주 분석)

```
아래 업비트 실시간 데이터(상위 10종목)를 참고만 해줘.

다음 4가지만 짧게 출력해. 다른 말 없이.

1) 현재 신호가 상대적으로 강한 1종목과 그 이유 (RSI·체결강도·거래량 기준, 1~2문장).
2) 기술적 근거 (지표 수치 언급).
3) 무효화 조건: 어떤 상황이 되면 이 신호가 무의미해지는지 1문장.
4) 리스크: 단기 조정·과매수·유동성 등 1문장.

※ 최종 매매 여부는 사용자 판단이며, 본 분석은 참고용입니다.

데이터:
{dataText}
```

### market-summary (시황 요약)

```
아래 한국 암호화폐 시장 데이터를 요약만 해줘. 3문단만 출력.

1문단: 비트코인·글로벌 흐름과 공포·탐욕 지수 요약.
2문단: 거래량 상위 중 지표상 관심 구간 1종목과 근거(참고용). '추천 매수'가 아닌 '관심 구간' 표현만 사용.
3문단: 단기 대응 시 유의할 점 3줄 (리스크·무효화 조건 포함).

※ 매매 결정은 사용자 책임입니다.

데이터:
{ctx}
```

### scalp-point (스캘핑 타점)

```
아래 RSI·체결강도·5분봉 데이터는 참고용입니다.

3문단 이내로만 답변해줘.

1) 현재 데이터 상에서 스캘핑 관점으로 신호가 상대적으로 나온 1종목과 그 이유 (지표 기준).
2) 진입 시 무효화 조건 (예: RSI 역전, 체결강도 하락 등).
3) 실패 시나리오와 리스크 1문장.

※ 수익을 보장하지 않으며, 최종 매매는 사용자 판단입니다.

데이터:
{dataText}
```

- 실패 시: `errorCode: GEMINI_UNAVAILABLE`, Embed에 "분석 일시 불가. 잠시 후 재시도하세요." + 위 EmbedMeta 포함.

---

## 10. 실제 Node.js 코드 구조 (폴더 + pseudo code)

### 폴더 구조 (이미 1번에 기술)

### Pseudo code 요약

```ts
// apps/api-server/index.ts
import express from 'express'; import { Server } from 'socket.io';
import { EventBus } from '../core/EventBus';
import { getState } from '../core/EngineState';
import { ProfitCalculationService } from '../core/services/ProfitCalculationService';

const app = express();
const server = createServer(app);
const io = new Server(server);

EventBus.on('dashboard:emit', (p) => io.emit('dashboard', p.lastEmit));
app.get('/api/analyst/scan-vol', async (req, res) => {
  const result = await analystScanVol();  // MarketSnapshotService + Gemini
  res.json(result);  // AppResult<AnalysisSnapshot>
});
server.listen(3000);
```

```ts
// apps/trading-engine/index.ts (또는 api-server 내부 모듈)
import { EventBus } from '../core/EventBus';
import { getState, setState } from '../core/EngineState';
import { CircuitBreaker } from '../core/CircuitBreaker';

setInterval(async () => {
  const assets = await CircuitBreaker.execute('upbit', () => fetchAssets());
  setState({ assets });
  await runScalpCycle();
  const lastEmit = buildDashboardPayload(getState());
  setState({ lastEmit, lastEmitAt: new Date().toISOString() });
  EventBus.emit('dashboard:emit', { lastEmit });
}, 1000);
```

```ts
// apps/discord-operator/index.ts
import { Client, Events } from 'discord.js';
import { PermissionService } from '../core/services/PermissionService';
import { AuditLogService } from '../core/services/AuditLogService';

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton() && !interaction.isChatInputCommand()) return;
  const ctx = PermissionService.from(interaction);
  if (!PermissionService.can(ctx, getCommandName(interaction))) return replyEphemeral('권한 없음');
  if (isDangerCommand(interaction)) return startConfirmFlow(interaction);
  const result = await runCommand(interaction);
  AuditLogService.log({ userId: interaction.user.id, command: getCommandName(interaction), success: result.ok });
  await replyWithEmbed(interaction, toEmbed(result), embedMeta);
});
```

```ts
// core/services/ProfitCalculationService.ts
export function getSummary(assets: AssetSummary | null): { profitPct: number; totalEval: number; totalBuy: number; krw: number } {
  if (!assets) return { profitPct: 0, totalEval: 0, totalBuy: 0, krw: 0 };
  const denom = (assets.totalBuyKrwForCoins ?? assets.totalBuyKrw ?? 0) + (assets.orderableKrw ?? 0);
  const profitPct = denom <= 0 ? 0 : (assets.totalEvaluationKrw / denom - 1) * 100;
  return { profitPct, totalEval: assets.totalEvaluationKrw, totalBuy: assets.totalBuyKrwForCoins ?? 0, krw: assets.orderableKrw ?? 0 };
}
```

- Discord/웹/emit 모두 `ProfitCalculationService.getSummary(EngineState.assets)` 결과만 사용. 프론트 fallback 계산 제거.

---

## 11. 구현 순서 (단계별)

### 1단계: 보안 (2~3주)

1. 환경변수 검증: 부팅 시 `DISCORD_TOKEN`, `CHANNEL_ID`, `ADMIN_ID`, `UPBIT_ACCESS_KEY`, `UPBIT_SECRET_KEY`, `GEMINI_API_KEY` 검사, 누락 시 `process.exit(1)`.
2. `shared/errors.ts`에 `AppErrorCode` enum 정의 (AUTH_*, UPBIT_*, GEMINI_*, DISCORD_*).
3. `PermissionService`: superAdmin/admin/analyst/viewer, 채널 allowlist, `can(ctx, command)` 구현.
4. 위험 명령 2단계 확인: engine_stop, sell_all → confirm 토큰 + 5분 TTL + `AuditLogService.log(..., approved: true/false)`.
5. Rate limit: 사용자별 분당 15회 (메모리 Map + 카운터).
6. `AuditLogService`: SQLite 테이블 (userId, command, at, success, errorCode, approved) 저장.

### 2단계: 구조 분리 (3~4주)

1. `src/core/EngineState.ts` 단일 state 객체 + getState/setState.
2. `src/core/EventBus.ts` emit/on 구현.
3. `ProfitCalculationService.getSummary()` 도입, 수익률/총자산 계산을 이 함수만 사용하도록 server/discord/emit 전부 교체. 프론트 fallback 제거.
4. server.js를 `src/apps/api-server` + `src/apps/trading-engine` 모듈로 분할 (같은 프로세스라도 폴더/파일 분리).
5. Discord 쪽을 `src/apps/discord-operator`로 분리 (진입점만 옮겨도 됨).
6. 응답 포맷: `AppResult<T>`, Embed 빌드 시 `EmbedMeta` (timestamp, model, dataRange, symbolCount, errorCode) 필수.

### 3단계: 성능 개선 (2~3주)

1. `core/cache/TtlCache.ts` 구현, TTL·invalidate(키 또는 prefix) 지원.
2. 상위 종목·RSI/체결강도·계좌 요약에 캐시 적용 (6번 TTL 표 준수).
3. `CircuitBreaker` 구현, Upbit/Gemini/Discord 호출 래핑.
4. Discord 재연결: 지수 백오프 30→60→120→300초, 최대 300초.

### 4단계: UX 개선 (2~3주)

1. Slash command 등록: /engine start|stop, /status, /pnl, /analyst scan-vol|summary|indicators.
2. 모든 Embed에 EmbedMeta (timestamp, model, dataRange, symbolCount, errorCode) 포함.
3. Gemini 프롬프트 3개(scan-vol, market-summary, scalp-point)를 9번 개선안으로 교체.
4. 헬스체크 DM을 운영 리포트 Embed로 변경 (프로세스·마지막 주문·에러 수·Gemini 실패·Upbit·Discord·lastEmitAt·메모리).

---

## 12. 가장 먼저 수정해야 할 Top 5

1. **ProfitCalculationService 단일화** — 수익률·총자산을 한 서비스에서만 계산하고, Discord/웹/emit/Socket payload가 모두 그 결과만 사용. 프론트 fallback 제거.
2. **위험 명령 2단계 확인** — engine_stop, sell_all에 확인 버튼·토큰·5분 TTL·감사 로그(approved) 저장.
3. **환경변수 검증 + AppErrorCode** — 부팅 시 필수 env 검사 후 종료, 에러 시 응답에 AppErrorCode 포함.
4. **감사 로그 저장** — SQLite 한 테이블로 userId, command, at, success, errorCode, approved 저장 (최소 30일).
5. **Discord 재연결 지수 백오프 + 헬스체크 운영 리포트** — 30초 고정 제거, 1시간마다 관리자 DM에 Embed 운영 리포트(프로세스·마지막 주문·에러·Gemini·Upbit·Discord·리소스) 전송.

---

*문서 끝. Cursor AI는 이 명세를 기준으로 폴더·파일·함수 시그니처·타입·pseudo code를 실제 Node.js/TypeScript 코드로 생성할 수 있다.*
