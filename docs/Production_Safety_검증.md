# Refactor 구조 Production Safety 검증

검증일: 2025-03 기준  
대상: discord-operator, api-server, market-bot, engine (PM2 ecosystem.refactor)

---

## 1. 현재 구현 위험도 분석

### 1-1. api-server 포트 재시도 로직 — 리스너 누적 여부

| 항목 | 내용 | 위험도 |
|------|------|--------|
| **구조** | `tryListen()` 진입 시 `httpServer.once('error', ...)` 1회 등록 후 `listen(PORT, onListenSuccess)` 호출 | 낮음 |
| **실패 시** | EADDRINUSE 발생 → `once` 핸들러 1회 실행 후 **자동 제거** → `setTimeout`으로 한 번만 `tryListen()` 재호출 → 새 `once('error')` 1개만 추가 | 누적 없음 |
| **성공 시** | `error` 이벤트 미발생 → 등록된 `once` 리스너 1개만 서버에 유지(정상적인 서버 error 처리용) | 누적 없음 |
| **타이머** | `listenRetryTimer !== null` 가드로 재시도 중복 스케줄 방지 | 안전 |

**결론**: 리스너·타이머 모두 누적 없이 안전. 수정 불필요. 문서화 목적 주석만 추가함.

---

### 1-2. /api/services-status — market-bot timeout으로 전체 API block 여부

| 항목 | 내용 | 위험도 |
|------|------|--------|
| **기존** | `proxyToMarketBot()`에 timeout 없음. market-bot 무응답 시 `fetch()`가 플랫폼 기본(수십 초~수 분)까지 대기 가능 | 중간 |
| **영향** | Node 단일 스레드에서 해당 요청 핸들러만 오래 대기. **다른 라우트는 별도 요청이므로 이벤트 루프 상에서 순차 처리되며**, 한 요청의 긴 await가 다른 요청의 “시작”을 막지는 않음. 다만 `/api/services-status` 호출자(Discord·대시보드)가 장시간 대기하고, 동시에 많은 services-status 호출이 쌓이면 불필요한 연결/대기 유지 | 중간 |
| **권장** | services-status 전용 **짧은 timeout** 적용 시, market-bot 장애/지연 시에도 5초 내 응답(apiServer: true, marketBot: false 등) 보장. 다른 API는 기존대로 timeout 없이 사용 가능 | — |

**결론**: “전체 API가 block된다”는 수준은 아니나, services-status는 **타임아웃 추가**로 운영 안정성·UX 개선 필요. 반영함.

---

### 1-3. process.memoryUsage 로그 — memory leak 추적

| 항목 | 내용 | 위험도 |
|------|------|--------|
| **현재** | listen 성공 후 5분 간격 `setInterval`로 `rss`, `heapUsed`, `heapTotal` 로그 출력 | 적절 |
| **추가 권장** | `external`(Buffer·C++ 바인딩 등) 포함 시 heap 밖 메모리 증가 추적 가능. leak 의심 시 조사 포인트 명확해짐 | 개선 |

**결론**: 기존 로그 유지 + **external 추가**로 leak 추적에 유리하도록 반영함.

---

## 2. 수정 필요한 파일

| 파일 | 수정 목적 |
|------|------------|
| `dashboard/src/apps/api-server/src/index.ts` | proxyToMarketBot에 timeout 옵션, services-status에 5초 timeout 및 Promise.all, 포트 재시도 주석, memory 로그에 external 추가 |

---

## 3. 실제 코드 수정안

### 3-1. proxyToMarketBot — timeout 옵션

- **위치**: `dashboard/src/apps/api-server/src/index.ts`
- **변경**: `opts`에 `timeoutMs?: number` 추가. 지정 시 `AbortController` + `setTimeout`으로 fetch 중단, 성공/실패 모두 `clearTimeout` 호출.

```ts
/** timeoutMs: 지정 시 해당 시간 내 응답 없으면 503 반환. /api/services-status 등에서 API 전체 block 방지용. */
async function proxyToMarketBot(
  path: string,
  opts?: { method?: string; body?: any; timeoutMs?: number }
): Promise<{ ok: boolean; data?: any; status?: number }> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const signal =
    opts?.timeoutMs != null && opts.timeoutMs > 0
      ? (() => {
          const controller = new AbortController();
          timeoutId = setTimeout(() => controller.abort(), opts.timeoutMs);
          return controller.signal;
        })()
      : undefined;
  try {
    const res = await fetch(MARKET_BOT_URL + path, {
      method: opts?.method || 'GET',
      headers: opts?.body ? { 'Content-Type': 'application/json' } : undefined,
      body: opts?.body ? JSON.stringify(opts.body) : undefined,
      signal,
    });
    if (timeoutId) clearTimeout(timeoutId);
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, data, status: res.status };
  } catch (e) {
    if (timeoutId) clearTimeout(timeoutId);
    return { ok: false, data: { error: (e as Error).message }, status: 503 };
  }
}
```

### 3-2. /api/services-status — 5초 timeout + 병렬 호출

- **변경**: `SERVICES_STATUS_TIMEOUT_MS = 5000` 상수 도입. `/status`, `/engine-status`를 `Promise.all` + `timeoutMs`로 호출.

```ts
const SERVICES_STATUS_TIMEOUT_MS = 5000;

app.get('/api/services-status', async (_req: Request, res: Response) => {
  const [statusR, engineR] = await Promise.all([
    proxyToMarketBot('/status', { timeoutMs: SERVICES_STATUS_TIMEOUT_MS }),
    proxyToMarketBot('/engine-status', { timeoutMs: SERVICES_STATUS_TIMEOUT_MS }),
  ]);
  const marketBot = statusR.ok === true;
  const engineRunning = engineR.ok && engineR.data && (engineR.data as { status?: string }).status === 'RUNNING';
  res.json({
    apiServer: true,
    marketBot,
    engineRunning: !!engineRunning,
  });
});
```

### 3-3. 포트 재시도 — 리스너 누적 없음 문서화 주석

- **위치**: 포트 재시도 상수 블록 위
- **내용**: `once('error')` 사용으로 시도당 1개만 등록, EADDRINUSE 시 제거 후 재시도 시 1개만 다시 등록, 성공 시 1개 유지(누적 없음) 명시.

### 3-4. 메모리 로그 — external 추가

- **위치**: `onListenSuccess()` 내 `setInterval` 콜백
- **변경**: `process.memoryUsage()`의 `external`을 MB 단위로 로그에 포함.

```ts
const externalMb = Math.round((mu as NodeJS.MemoryUsage).external / 1024 / 1024);
console.log('[api-server][memory] rss=' + rssMb + 'MB heapUsed=' + heapUsedMb + 'MB heapTotal=' + heapTotalMb + 'MB external=' + externalMb + 'MB');
```

---

## 4. 왜 이 수정이 필요한지 설명

| 수정 | 이유 |
|------|------|
| **services-status timeout** | market-bot 다운/과부하 시에도 Discord·대시보드가 5초 안에 “api-server 🟢, market-bot 🔴” 등으로 응답받아, 한 요청이 무한 대기하지 않도록 함. 다른 라우트는 기존처럼 timeout 없이 사용. |
| **Promise.all** | `/status`와 `/engine-status`를 병렬 호출해 응답 시간 단축(최대 약 5초). |
| **포트 재시도 주석** | 향후 유지보수 시 “리스너가 계속 쌓이지 않나?” 의문 제거 및 production safety 검증 결과 고정. |
| **memory external** | heap 외 메모리(Buffer, 네이티브 등) 증가 시 로그로 확인 가능. 800M 제한·leak 조사 시 조사 포인트 명확화. |

---

## 5. 운영 환경에서 기대 효과

| 항목 | 기대 효과 |
|------|------------|
| **포트 재시도** | 기존대로 listener 누적 없음. PM2 재시작 루프 완화된 상태 유지. |
| **services-status** | market-bot 무응답 시에도 5초 내 JSON 응답. Discord “현재 상태” 버튼/슬래시가 오래 멈추는 현상 감소. |
| **메모리 로그** | 5분마다 rss/heapUsed/heapTotal/external 기록. 시간순 로그로 상승 추이 확인 가능. max_memory_restart 800M·node heap 768M과 함께 leak 의심 시 다음 조사 포인트(스케줄/캐시/대량 객체 유지)로 활용 가능. |

---

## 6. 롤백 포인트

- **proxyToMarketBot**: `timeoutMs` 관련 분기 및 `AbortController`/`setTimeout`/`clearTimeout` 제거 후 기존 단순 `fetch`만 사용.
- **services-status**: `timeoutMs` 제거, 직렬 호출로 복원.
- **memory**: `external` 로그 한 줄 제거.
- **주석**: 포트 재시도 설명 주석만 제거하면 됨.
