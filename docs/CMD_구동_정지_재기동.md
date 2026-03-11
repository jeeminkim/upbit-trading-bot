# CMD에서 구동 / 정지 / 강제 종료 / 재기동 (통일 가이드)

**리팩터 스택**(api-server + discord-operator + market-bot) 기준. 모든 명령은 **dashboard 폴더**에서 실행.

---

## 1. 사전: 프로젝트 폴더로 이동

```cmd
cd /d "c:\Users\kingj\OneDrive\문서\upbit-price-alert\dashboard"
```

---

## 2. 구동 (시작)

```cmd
npm run pm2:refactor
```

- TypeScript 빌드 후 api-server, discord-operator, market-bot 을 PM2 로 기동.
- 매매 엔진은 **자동으로 시작되지 않음**. Discord `/engine start` 또는 대시보드에서 명시적으로 시작해야 함.

---

## 3. 정지 (정상 종료)

```cmd
npm run pm2:refactor:stop
```

- api-server, discord-operator, market-bot 프로세스를 PM2 에서 삭제(정상 종료).
- 다른 PM2 앱(upbit-bot, MarketSearchEngine 등)이 있으면 그건 그대로 둠.

---

## 4. 문제 발생 시 — 프로세스 바로 kill (강제 종료)

### 4-1. PM2 로 관리 중인 프로세스만 정리

```cmd
npm run pm2:refactor:stop
pm2 kill
```

- `pm2 kill`: PM2 데몬과 PM2 가 띄운 모든 프로세스를 종료.  
  리팩터 3개 앱만 쓸 때는 위 두 줄이면 충분.

### 4-2. 그래도 안 죽을 때 — Node 프로세스 강제 종료 (Windows)

```cmd
taskkill /F /IM node.exe
```

- **주의**: PC에서 돌아가는 **모든** Node 프로세스가 종료됨.  
  다른 Node 앱이 있으면 같이 꺼지므로, 리팩터 앱만 문제일 때는 먼저 4-1 시도.

### 4-3. 포트 3000 을 쓰는 프로세스만 kill (선택)

```cmd
for /f "tokens=5" %a in ('netstat -ano ^| findstr :3000') do taskkill /F /PID %a
```

- 3000 포트만 점유한 프로세스만 종료할 때 사용. CMD 한 줄 입력 시 `%a` 그대로, 배치 파일에서는 `%%a`.

---

## 5. 수정 후 재기동 (빌드 + 재시작)

```cmd
npm run pm2:refactor:restart
```

- `build:refactor` 후 ecosystem.refactor.config.cjs 기준으로 3개 앱 **재시작**.
- 코드 수정 후 다시 띄울 때 이 명령 하나로 통일.

---

## 6. 자주 쓰는 명령 요약

| 목적           | 명령어 |
|----------------|--------|
| **구동**       | `npm run pm2:refactor` |
| **정지**       | `npm run pm2:refactor:stop` |
| **재기동**     | `npm run pm2:refactor:restart` |
| **문제 시 kill** | `npm run pm2:refactor:stop` → `pm2 kill` (필요 시 `taskkill /F /IM node.exe`) |
| **로그 보기**  | `npm run pm2:refactor:logs` |
| **상태 확인**  | `pm2 status` |

---

## 7. 한 번에 복사해서 쓰기 (CMD)

**구동**
```cmd
cd /d "c:\Users\kingj\OneDrive\문서\upbit-price-alert\dashboard"
npm run pm2:refactor
```

**정지**
```cmd
cd /d "c:\Users\kingj\OneDrive\문서\upbit-price-alert\dashboard"
npm run pm2:refactor:stop
```

**문제 시 강제 종료 후 재기동**
```cmd
cd /d "c:\Users\kingj\OneDrive\문서\upbit-price-alert\dashboard"
npm run pm2:refactor:stop
pm2 kill
npm run pm2:refactor
```

**수정 후 재기동**
```cmd
cd /d "c:\Users\kingj\OneDrive\문서\upbit-price-alert\dashboard"
npm run pm2:refactor:restart
```
