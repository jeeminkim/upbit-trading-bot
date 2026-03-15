# PM2 로그 관리 및 Windows 부팅 시 자동 시작

미니PC(Lenovo 등) 저사양 환경에서 로그가 쌓이지 않도록 하고, Windows 부팅 시 봇이 자동으로 켜지도록 설정하는 방법입니다.

---

## 1. 로그 로테이션 (pm2-logrotate)

PM2 기본 로그는 `~/.pm2/logs/` 에 쌓이며, 로테이션 없이 계속 커질 수 있습니다. `pm2-logrotate` 모듈로 크기·개수 제한을 둡니다.

### 설치 (전역 1회)

```bash
npm install -g pm2-logrotate
```

### 권장 설정 (미니PC용)

```bash
# 로그 파일당 최대 10MB
pm2 set pm2-logrotate:max_size 10M

# 보관 개수 (초과 시 오래된 것 삭제)
pm2 set pm2-logrotate:retain 7

# 압축 보관 (선택)
pm2 set pm2-logrotate:compress true
```

### 확인

```bash
pm2 conf pm2-logrotate
```

---

## 2. Windows 부팅 시 PM2 자동 시작

Windows에서는 `pm2 startup`이 Linux처럼 동작하지 않습니다. **작업 스케줄러(Task Scheduler)** 로 부팅/로그인 시 PM2 앱을 복구하도록 설정합니다.

### 2-1. 현재 앱 목록 저장

한 번 봇을 실행한 뒤, 다음으로 목록을 저장해 두세요.

```bash
cd c:\Users\kingj\OneDrive\문서\upbit-price-alert\dashboard
pm2 start ecosystem.config.cjs
pm2 save
```

이후 재부팅 시 `pm2 resurrect` 로 이 목록을 그대로 복구할 수 있습니다.

### 2-2. 부팅 시 실행할 배치 파일

프로젝트에 포함된 `scripts/pm2-resurrect-on-boot.bat` 를 사용하거나, 아래 내용으로 직접 만듭니다.

- **트리거**: 사용자 로그온 시 또는 시스템 부팅 시
- **동작**: `pm2 resurrect` 실행 (저장된 앱 목록 복구)

### 2-3. 작업 스케줄러 등록 절차

1. **작업 스케줄러** 열기 (Win + R → `taskschd.msc`)
2. **기본 작업 만들기** → 이름: `PM2 Resurrect (Upbit Bot)`
3. **트리거**: "컴퓨터 시작 시" 또는 "사용자가 로그온할 때"
4. **동작**: "프로그램 시작"
   - **프로그램/스크립트**: `pm2` (또는 `C:\Program Files\nodejs\pm2.cmd` 등 pm2 전체 경로)
   - **인수**: `resurrect`
   - **시작 위치**: `c:\Users\kingj\OneDrive\문서\upbit-price-alert\dashboard`
5. **조건**: "다음 네트워크 연결을 사용할 수 있을 때" 체크 해제 권장(부팅 직후에도 실행)
6. **설정**: "가능한 경우 관리자 권한으로 실행" 필요 시 체크

PowerShell로 매 로그온 시 실행하려면:

- **프로그램**: `powershell.exe`
- **인수**: `-WindowStyle Hidden -Command "cd 'c:\Users\kingj\OneDrive\문서\upbit-price-alert\dashboard'; pm2 resurrect"`

---

## 3. 스크립트 요약

| 파일 | 용도 |
|------|------|
| `ecosystem.config.cjs` | upbit-bot + MarketSearchEngine 앱 정의 |
| `scripts/pm2-resurrect-on-boot.bat` | 부팅/로그인 시 `pm2 resurrect` 호출 (작업 스케줄러에서 지정) |
| `docs/PM2_LOGS_AND_STARTUP.md` | 이 문서 |

---

## 4. 참고 명령어

```bash
# 앱 목록 저장 (재부팅 후 복구용)
pm2 save

# 저장된 목록으로 앱 복구
pm2 resurrect

# 전체 재시작
npm run restart:all

# 로그 보기
npm run log
# 또는
pm2 logs
```
