# 리팩터 프로젝트 구조

## 폴더 구조

```
dashboard/src/
├── packages/
│   ├── shared/src/          # 공통 타입·에러
│   │   ├── types.ts         # PermissionLevel, AppResult, EngineStateSnapshot, EventType, AuditLogEntry, EmbedMeta
│   │   ├── errors.ts        # AppErrorCode
│   │   └── index.ts
│   └── core/src/            # 핵심 서비스
│       ├── EventBus.ts      # emit(type, payload), subscribe(type, fn)
│       ├── EngineStateService.ts  # getState(), setState(), setBotEnabled(), setLastOrderAt()...
│       ├── CircuitBreakerService.ts  # execute('upbit'|'gemini'|'network', fn), getState(), reset()
│       ├── PermissionService.ts  # from(), can(), isDangerCommand(), checkRateLimit()
│       ├── ProfitCalculationService.ts  # getSummary(assets), formatPct()
│       ├── AuditLogService.ts    # log(entry), getRecent(limit)
│       ├── AuditLogDb.ts    # getDbSync(), SQLite audit_log 테이블
│       ├── HealthReportService.ts  # build(processName, opts), recordError(), recordGeminiFailure()
│       ├── TtlCache.ts      # get(), set(), invalidate(), CACHE_TTL
│       ├── ConfirmFlow.ts   # create(userId, command), consume(token, userId), cancel(token)
│       └── index.ts
├── apps/
│   ├── api-server/src/
│   │   └── index.ts         # Express, Socket.IO, /api/health, /api/dashboard, /api/analyst/*, EventBus.subscribe('DASHBOARD_EMIT')
│   ├── trading-engine/src/
│   │   └── index.ts         # setInterval(runCycle), fetchAssets, runScalpCycle, EventBus.emit('DASHBOARD_EMIT')
│   ├── discord-operator/src/
│   │   └── index.ts         # Client, slash 등록, handleInteraction(버튼/confirm/slash), AuditLogService, ConfirmFlow
│   └── market-bot/src/
│       └── index.ts         # Client, DASHBOARD_URL/api/analyst/* 호출
```

## 빌드 및 실행

```bash
# TypeScript 빌드
npx tsc -p tsconfig.refactor.json

# PM2 (리팩터 구조)
pm2 start ecosystem.refactor.config.cjs
```

## 구현 요약

- **EventBus**: emit / subscribe, 이벤트 타입 ENGINE_STARTED, ENGINE_STOPPED, ORDER_FILLED, DASHBOARD_EMIT 등.
- **EngineStateService**: 싱글톤 state (botEnabled, lastOrderAt, cooldownUntil, dailyPnL, openOrders, assets).
- **CircuitBreakerService**: upbit/gemini/network 별 5회 실패 시 OPEN, 1분 후 HALF_OPEN.
- **PermissionService**: superAdmin/admin/analyst/viewer, 채널 allowlist, 분당 15회 rate limit, isDangerCommand.
- **ProfitCalculationService**: getSummary(assets) 단일 공식, 분모 0이면 0%.
- **AuditLogService**: SQLite audit_log (user_id, command, timestamp, success, error_code, approved, order_created).
- **ConfirmFlow**: engine_stop, sell_all 2단계 확인, 토큰 TTL 5분.
- **TtlCache**: get/set/invalidate, CACHE_TTL (TOP_TICKERS 10s, RSI 15s, MARKET 60s, ACCOUNT 5s).
- **Discord**: slash /engine start|stop, /status, /pnl, /analyst scan-vol|summary|indicators; 버튼 confirm_/cancel_ 플로우.
