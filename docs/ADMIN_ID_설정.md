# Discord ADMIN_ID 설정

## 코드에서 실제로 보는 변수 (우선순위)

| 용도 | 우선 사용 | 그다음 |
|------|-----------|--------|
| **권한 판별** (전략 모드, 엔진 시작/정지 등) | **ADMIN_ID** | SUPER_ADMIN_ID, ADMIN_IDS(복수) |
| discord-operator 관리자 체크 | **ADMIN_ID** | DISCORD_ADMIN_ID |
| server.js apiKeys.discordAdminId | **ADMIN_ID** | DISCORD_ADMIN_ID, config |
| 역할 C(인프라) 전용 | ADMIN_DISCORD_ID | (미설정 시 ADMIN_ID 사용) |

**정리**: 운영자가 Discord에서 본인만 관리자로 쓰려면 **ADMIN_ID** 하나만 설정하면 됨. 로그에도 기본적으로 "ADMIN_ID 사용"으로 표시됨.

## 설정 방법

1. **Discord에서 본인 User ID 복사**
   - Discord 설정 → 앱 설정 → 고급 → **개발자 모드** 켜기
   - 서버/DM에서 **본인 닉네임 우클릭** → **"사용자 ID 복사"**

2. **.env에 넣기**
   ```env
   ADMIN_ID=여기에_복사한_숫자_ID_붙여넣기
   ```

3. **PM2 사용 시**
   - .env 수정 후 **반드시 재기동**해야 env 반영됨.
   ```cmd
   npm run pm2:refactor:restart
   ```
   - 또는 PM2 ecosystem에서 `env: { ADMIN_ID: '...' }` 로 줄 수도 있음.

## startup 로그로 확인

- **설정됨**: `[startup] ADMIN_ID loaded: Yes (ADMIN_ID)` 또는 `Yes (ADMIN_DISCORD_ID)` 등
- **미설정**: `[startup] ADMIN_ID loaded: No` + 경고 3줄

리팩터 스택 기동 시 api-server 로그에도 `ADMIN_ID loaded: Yes/No` 가 한 줄로 나옴.
