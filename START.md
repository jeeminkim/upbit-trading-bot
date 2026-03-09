# 대시보드 + Discord 봇 한 번에 실행하기

**단일 진입점: `server.js`만 실행하세요.** 포트 3000에서 웹 대시보드와 디스코드 봇이 함께 구동됩니다.

- Express 웹 서버 (대시보드 페이지)
- Scalp 매매 엔진 (주기 실행)
- Discord 봇 (제어 패널·체결/오류 알림)

⚠️ `server.js`와 `discord_agent.js`를 **동시에** 실행하면 포트 3000 충돌이 납니다. **한 가지만** 실행하세요.

---

## 1. 한 번에 실행 (권장)

```bash
cd C:\Users\kingj\OneDrive\문서\upbit-price-alert\dashboard
npm start
```

(= `node server.js`)  
서버가 뜨면 대시보드 웹이 켜지고, `.env` 또는 `config.json`에 Discord 설정이 있으면 같은 프로세스에서 봇이 로그인해 제어 패널을 보냅니다.

---

## 2. 필요한 설정 (.env 또는 config.json)

Discord 봇까지 쓰려면 아래 중 하나에 넣습니다.

**.env**
- `DISCORD_TOKEN` 또는 `DISCORD_BOT_TOKEN` — 봇 토큰
- `CHANNEL_ID` 또는 `DISCORD_CHANNEL_ID` — 제어 패널·알림 채널 ID
- (선택) `ADMIN_ID` 또는 `DISCORD_ADMIN_ID` — 버튼 사용할 본인 디스코드 사용자 ID

**config.json**
- `discord_token` 또는 `discord_bot_token`
- `channel_id` 또는 `discord_channel_id`
- (선택) `admin_id` 또는 `discord_admin_id`

설정한 뒤 **`npm start` 한 번**이면 됩니다.

---

## 3. 24시간 백그라운드 실행 (PM2)

PM2는 **server.js 하나만** 실행합니다 (포트 3000 + 디스코드 봇 통합).

```bash
cd C:\Users\kingj\OneDrive\문서\upbit-price-alert\dashboard
npm run pm2:start
```

(= `npx pm2 start ecosystem.config.cjs` — script: server.js)

- 프로세스 이름: `scalp-dashboard`
- `npm run pm2:logs` — 로그 보기
- `npm run pm2:restart` — 재시작
- `npm run pm2:stop` — 중지

자세한 내용은 `docs/PM2_DISCORD_AGENT.md`를 보세요.
