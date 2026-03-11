# 패널 복구 진단 로그

## 1) 관련 파일/함수 목록

| 파일 | 함수/역할 |
|------|------------|
| `src/apps/discord-operator/src/index.ts` | `panelRestoreWarn(tag, detail)` — PANEL_RESTORE 경로용 logWarn (LOG_LEVEL 무관 출력) |
| `src/apps/discord-operator/src/index.ts` | `panelRestoreFail(tag, err, extra)` — 실패 시 logError + stack 일부 |
| `src/apps/discord-operator/src/index.ts` | `buildPanelComponents()` — 5 row 버튼 배열 반환 |
| `src/apps/discord-operator/src/index.ts` | `restorePanel(channel)` — state 로드 → fetch/edit 또는 send new → state 저장, 성공 시 true |
| `src/apps/discord-operator/src/index.ts` | `sendRestartMessage(channel, panelRestored)` — 재기동 안내 전송, 복구 완료/실패 문구 반영 |
| `src/apps/discord-operator/src/index.ts` | `client.once('ready')` — READY 로그 → restorePanel → sendRestartMessage |
| state | `process.cwd()/state/discord-panel.json` — channelId, panelMessageId 저장/조회 (별도 함수 없이 restorePanel 내부에서 fs 직접 사용) |

## 2) 원인 후보 정리

"복구 완료"가 뜨지만 실제 패널(버튼)이 안 보일 수 있는 경우:

1. **우선순위 1: restorePanel이 잘못 true를 반환**  
   - edit 또는 send가 실패했는데 catch에서 로그만 하고 fall through 후 send new도 실패하면 false를 반환해야 함.  
   - 이전에는 edit 실패 시 catch 후 "sending new"로 넘어가고, send가 성공하면 true를 반환. **다만 send가 실패(예: 권한/API 오류)하면 반드시 false**여야 하고, **그때 "복구 실패"가 표시**되어야 함.  
   - 진단: DONE restored=true가 찍혔는데 패널이 없다면, **다른 채널에 메시지가 갔거나**, **같은 채널이지만 스크롤/캐시 문제**일 수 있음. 로그에 `panelMessageId`가 있으므로 해당 ID로 Discord에서 검색 가능.

2. **우선순위 2: 로그가 안 보여서 원인을 못 찾는 경우**  
   - 기존에 `console.log`로만 찍으면 PM2/환경에서 stdout이 버퍼되거나 로그 레벨에 의해 가려질 수 있음.  
   - **대응**: 모든 [PANEL_RESTORE] 경로 로그를 **LogUtil.logWarn** 또는 **LogUtil.logError**로 통일해 NORMAL에서도 항상 출력되게 함. 실패는 **panelRestoreFail**로 stack 일부까지 기록.

3. **우선순위 3: 기존 메시지 edit 성공이지만 Discord 쪽에서 components 미반영**  
   - edit API는 성공했는데 Discord 클라이언트가 components를 숨기거나 오래된 메시지로 표시하는 경우(드묾).  
   - 진단: **EDIT_OK** + **panelMessageId**가 로그에 있으면, 해당 메시지 ID로 Discord에서 "해당 메시지로 이동" 등으로 확인 가능. **SEND_NEW_OK**가 찍리면 새 메시지가 생성된 것이므로, 그 messageId가 실제 패널 메시지.

## 3) 실제 코드 패치 요약

- **panelRestoreWarn / panelRestoreFail**  
  - 추가. `[PANEL_RESTORE][{tag}]` + JSON 또는 error+stack. logWarn/logError 사용으로 NORMAL에서도 출력.

- **restorePanel**  
  - **COMPONENTS_BUILT** / **COMPONENTS_INVALID**: buildPanelComponents() 직후 rows, counts, firstIds 로그. rows>5 또는 row당 버튼>5 또는 빈 row 시 COMPONENTS_INVALID + logError.  
  - **STATE_LOADED** / **STATE_LOAD_FAIL**: state 파일 유무, channelId, messageId, 로드 예외 시 stack.  
  - **START**: state 로드 후 channelId, savedPanelMessageId, savedChannelId.  
  - **CHANNEL_MISMATCH**: 저장된 채널과 현재 채널 다르면 로그.  
  - **FETCH_EXISTING** → **FETCH_EXISTING_OK** 또는 **FETCH_EXISTING_FAIL** (실패 시 stack).  
  - **EDIT_START** → **EDIT_OK** 또는 **EDIT_FAIL** (실패 시 stack).  
  - **STATE_SAVE_OK** / **STATE_SAVE_FAIL**: 저장 성공/실패, 실패 시 stack.  
  - **SEND_NEW_START** → **SEND_NEW_OK** 또는 **SEND_NEW_FAIL** (실패 시 stack).  
  - **DONE**: restored=true/false, mode=edit|new, panelMessageId 또는 reason.  
  - 에러를 catch 후 로그만 하고 넘어가는 구간 제거: 모든 catch에서 panelRestoreFail 호출, fetch 실패와 edit 실패 분리.

- **sendRestartMessage**  
  - **RESTART_MESSAGE**: panelRestored, panelStatusText(복구 완료/복구 실패) 로그.  
  - **RESTART_MESSAGE_SENT**: restartMessageId, panelRestored.  
  - **RESTART_MESSAGE_FAIL**: 전송 실패 시 logError + stack.

- **ready**  
  - **READY**: 진입 시 clientId, channelId.  
  - 채널 fetch 실패 시 **CHANNEL_FETCH_FAIL**.  
  - ready 전체 catch 시 **READY_SEQUENCE_FAIL**.  
  - channelId 없으면 **READY** skip, reason.

- **복구 완료 조건**  
  - "복구 완료"는 **restorePanel()이 true를 반환할 때만** 표시.  
  - true는 **edit 성공** 또는 **send 성공** 시에만 반환. state 저장 실패는 로그만 하고, edit/send 성공 여부로만 true/false 결정.

## 4) 기대 로그 시퀀스

### 정상 (기존 패널 메시지 편집 성공)

- [PANEL_RESTORE][READY] start ... clientId=... channelId=...
- [PANEL_RESTORE][STATE_LOADED] found=true channelId=... messageId=...
- [PANEL_RESTORE][START] channelId=... savedPanelMessageId=... savedChannelId=...
- [PANEL_RESTORE][COMPONENTS_BUILT] rows=5 counts=...
- [PANEL_RESTORE][FETCH_EXISTING] channelId=... messageId=...
- [PANEL_RESTORE][FETCH_EXISTING_OK] messageId=...
- [PANEL_RESTORE][EDIT_START] messageId=... contentLen=... rows=5
- [PANEL_RESTORE][EDIT_OK] messageId=...
- [PANEL_RESTORE][STATE_SAVE_OK] channelId=... messageId=...
- [PANEL_RESTORE][DONE] restored=true mode=edit panelMessageId=...
- [PANEL_RESTORE][RESTART_MESSAGE] panelRestored=true panelStatusText=복구 완료
- [PANEL_RESTORE][RESTART_MESSAGE_SENT] restartMessageId=... panelRestored=true

### 정상 (새 패널 메시지 전송)

- [PANEL_RESTORE][READY] ...
- [PANEL_RESTORE][STATE_LOADED] found=false 또는 found=true but 채널 불일치
- [PANEL_RESTORE][START] ...
- [PANEL_RESTORE][COMPONENTS_BUILT] ...
- [PANEL_RESTORE][SEND_NEW_START] channelId=... contentLen=... rows=5
- [PANEL_RESTORE][SEND_NEW_OK] messageId=...
- [PANEL_RESTORE][STATE_SAVE_OK] ...
- [PANEL_RESTORE][DONE] restored=true mode=new panelMessageId=...
- [PANEL_RESTORE][RESTART_MESSAGE] panelRestored=true
- [PANEL_RESTORE][RESTART_MESSAGE_SENT] ...

### 실패 (fetch 또는 edit 실패 후 send new 성공)

- ... FETCH_EXISTING → FETCH_EXISTING_FAIL ... (또는 EDIT_FAIL)
- [PANEL_RESTORE][SEND_NEW_START] ...
- [PANEL_RESTORE][SEND_NEW_OK] ...
- [PANEL_RESTORE][DONE] restored=true mode=new ...

### 실패 (패널 복구 완전 실패)

- ... SEND_NEW_FAIL ... (stack 포함)
- [PANEL_RESTORE][DONE] restored=false reason=send_failed
- [PANEL_RESTORE][RESTART_MESSAGE] panelRestored=false panelStatusText=복구 실패 (로그 확인)
- [PANEL_RESTORE][RESTART_MESSAGE_SENT] panelRestored=false

## 5) 검증 포인트

- **실제로 로그가 남는지**: NORMAL/ERROR_ONLY에서도 [PANEL_RESTORE] 계열은 logWarn/logError이므로 PM2 로그에 출력되는지 확인.
- **패널이 안 떠도 어디서 실패했는지**: FETCH_EXISTING_FAIL / EDIT_FAIL / SEND_NEW_FAIL / STATE_SAVE_FAIL 중 어떤 태그가 찍혔는지로 원인 구분.
- **"복구 완료" 거짓 양성 방지**: restorePanel()이 true를 반환하는 경우는 edit 성공 또는 send 성공 시뿐이며, 그때만 sendRestartMessage(panelRestored=true)가 호출되어 "복구 완료"가 표시됨. false 반환 시 "복구 실패 (로그 확인)" 표시.
- **messageId 추적**: DONE, SEND_NEW_OK, EDIT_OK, RESTART_MESSAGE_SENT에 panelMessageId / restartMessageId가 있으므로, Discord에서 해당 ID로 메시지 위치 확인 가능.
