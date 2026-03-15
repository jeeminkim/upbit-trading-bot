# PM2로 Discord 에이전트 24시간 실행 가이드

`discord_agent.js`는 대시보드(Express + Scalp 엔진)와 Discord 봇(MyScalpBot)을 **한 프로세스**에서 함께 실행하는 진입점입니다.  
PM2로 백그라운드에서 실행하면 PC가 켜져 있는 한 24시간 동작합니다.

---

## 1. 사전 준비

- Node.js 설치
- `dashboard` 폴더에서 `npm install` 완료
- `.env`에 다음 설정 완료:
  - `DISCORD_BOT_TOKEN` — 봇 토큰 (디스코드 개발자 포털)
  - `DISCORD_CHANNEL_ID` — 제어 패널·알림을 보낼 채널 ID
  - `DISCORD_ADMIN_ID` — 버튼 사용 허용할 본인 디스코드 사용자 ID

---

## 2. PM2 설치 (최초 1회)

```bash
npm install -g pm2
```

---

## 3. 에이전트 실행

**방법 A — ecosystem 파일 사용 (권장)**

```bash
cd c:\Users\kingj\OneDrive\문서\upbit-price-alert\dashboard
pm2 start ecosystem.config.cjs
```

- `scalp-dashboard`라는 이름으로 등록되며, **npm 서비스(대시보드) + Discord 봇**이 한 프로세스에서 함께 구동됩니다.

**방법 B — 스크립트 직접 지정**

```bash
cd c:\Users\kingj\OneDrive\문서\upbit-price-alert\dashboard
pm2 start discord_agent.js --name scalp-dashboard
```

- `discord_agent.js`가 `server.js`를 불러와 동일하게 대시보드 + Discord가 함께 실행됩니다.

---

## 4. 자주 쓰는 PM2 명령어

| 명령어 | 설명 |
|--------|------|
| `pm2 list` | 실행 중인 프로세스 목록 |
| `pm2 logs scalp-dashboard` | 대시보드+Discord 로그 실시간 보기 |
| `pm2 stop scalp-dashboard` | 중지 |
| `pm2 restart scalp-dashboard` | 재시작 |
| `pm2 delete scalp-dashboard` | 프로세스 삭제 |

---

## 5. 재부팅 후에도 자동 실행 (선택)

재부팅 후 PM2가 다시 올라오고, 그 안에서 `scalp-agent`도 자동 실행되게 하려면:

```bash
pm2 save
pm2 startup
```

`pm2 startup` 출력에 나오는 명령(예: `sudo env PATH=... pm2 startup systemd`)을 복사해 터미널에서 한 번 실행하면 됩니다.  
Windows에서는 작업 스케줄러로 `pm2 resurrect`를 로그인 시 실행하도록 설정하는 방법도 있습니다.

---

## 3-1. npm start와 Discord가 같이 돌아가는 이유

- `discord_agent.js`(또는 `server.js`) **한 프로세스** 안에 Express 대시보드와 Discord 봇이 함께 들어 있습니다.
- 따라서 PM2로 **한 앱만 띄우면** npm 서비스(웹 대시보드)와 Discord 봇이 동시에 구동됩니다. 별도로 두 개를 띄울 필요 없습니다.

---

## 6. 봇 이름 "MyScalpBot" 설정

봇의 표시 이름은 **디스코드 개발자 포털**에서 정합니다.

1. [Discord Developer Portal](https://discord.com/developers/applications) 접속
2. 해당 봇(애플리케이션) 선택 → **Bot** 메뉴
3. **Username**을 `MyScalpBot` 등 원하는 이름으로 변경 후 저장

코드에서는 토큰만 사용하므로, 별도 설정 없이 포털에서 바꾼 이름이 적용됩니다.

---

## 7. 동작 요약

- **엔진 가동**: 매매 엔진(botEnabled) 켜기 → "매매를 시작합니다" 안내
- **즉시 정지**: 엔진 끄기 + 미체결 주문 일괄 취소 → "매매를 중단합니다" 안내
- **현재 상태**: KRW 잔고, 수익률, 활성 전략 가중치를 임베드로 전송
- **전체 매도**: SCALP 대상 종목(KRW-BTC, KRW-ETH, KRW-XRP, KRW-SOL) 보유분 시장가 매도

버튼 클릭 시 해당 기능 실행 후 **"처리 완료"**가 ephemeral(본인만 보임)로 응답됩니다.
