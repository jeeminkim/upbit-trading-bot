# 패널 복구 수정 (재기동 후 버튼 미노출)

## 1) 원인 분석

- **순서 문제**: `ready`에서 **재기동 안내 메시지(sendRestartMessage)** 를 **패널 복구(restorePanel)** 보다 **먼저** 보냄. 그리고 "패널 상태 : 복구 완료"를 패널 복구 성공 여부와 관계없이 항상 표시함.
- **복구 완료 문구**: 패널을 아직 복구하지 않은 시점에 "복구 완료"가 안내 메시지에 포함되어, 사용자는 복구가 된 것으로 보이지만 실제 통제 패널(버튼) 메시지는 별도로 있어야 함.
- **메시지 구분**: 재기동 안내와 통제 패널은 **서로 다른 메시지**여야 함. 안내는 텍스트만, 패널은 content + **components(버튼)** 필수. 기존에도 restorePanel()은 `content`와 `buildPanelComponents()`를 함께 넘기고 있었으나, **실행 순서**와 **실패 시 처리**가 불명확했고, **채널/메시지 ID 불일치** 시 기존 메시지 편집 실패 후 새 메시지 전송이 한 번만 시도됨.
- **저장/조회**: `state/discord-panel.json`에 `channelId`, `panelMessageId` 저장. **channelId가 현재 채널과 다르면** (또는 저장된 messageId가 삭제된 메시지면) 편집 실패 → 새 메시지 전송으로 넘어가야 하는데, **channelId 검사가 없어** 다른 채널의 messageId로 fetch 시도 시 실패할 수 있음. 이번 수정에서 channelId 일치 여부를 명시적으로 검사하고, 불일치 시 "기존 패널 없음"으로 간주해 **항상 새 패널 메시지 전송**으로 유도함.

## 2) 관련 파일/함수

| 파일 | 함수/위치 |
|------|-----------|
| `src/apps/discord-operator/src/index.ts` | `restorePanel(channel)` — 패널 content + components 적용, 성공 시 true 반환 |
| `src/apps/discord-operator/src/index.ts` | `sendRestartMessage(channel, panelRestored)` — 재기동 안내, panelRestored에 따라 "복구 완료" / "복구 실패" |
| `src/apps/discord-operator/src/index.ts` | `client.once('ready')` — **restorePanel 먼저** 호출 후 **sendRestartMessage** 호출 |
| `src/apps/discord-operator/src/index.ts` | `buildPanelComponents()` — 5 row 버튼 (역할 A/B/C) |
| state 저장 | `process.cwd()/state/discord-panel.json` — `channelId`, `panelMessageId` |

## 3) 실제 코드 패치 요약

- **restorePanel**
  - 반환 타입 `Promise<boolean>` (성공 true, 실패 false).
  - **content**와 **components**를 상수로 한 번만 생성해, 편집/전송 시 동일하게 사용.
  - **channelId 일치** 여부 검사: `panelData.channelId === channel.id` 일 때만 기존 메시지 편집 시도. 불일치 시 "existing panel message not used (channel mismatch)" 로그 후 새 메시지 전송.
  - 기존 메시지 편집 실패( fetch 실패 포함) 시 즉시 **새 메시지 전송**으로 넘어가고, 성공 시에만 state 저장 후 true 반환.
  - **[PANEL_RESTORE] 로그** 강제 출력 (console.log, LOG_LEVEL 무관):
    - `[PANEL_RESTORE] start channelId=... panelFile=...`
    - `[PANEL_RESTORE] existing panel message found messageId=... savedChannelId=...` / `not found (no state file)` / `not found (read error) ...`
    - 채널 불일치 시: `existing panel message not used (channel mismatch, will send new)`
    - `[PANEL_RESTORE] editing existing panel message` → 성공 시 `success (edited)`, 실패 시 `failure (edit) ...`
    - `[PANEL_RESTORE] sending new panel message` → 성공 시 `success (new message)`, 실패 시 `failure ...`
- **sendRestartMessage**
  - 두 번째 인자 `panelRestored: boolean` 추가. `true`일 때만 "패널 상태 : 복구 완료", `false`일 때 "패널 상태 : 복구 실패 (로그 확인)".
- **ready**
  - `const panelRestored = await restorePanel(channel);` → `await sendRestartMessage(channel, panelRestored);` 순서로 변경. 재기동 안내는 **패널 복구 이후**에만 전송.

## 4) 재기동 후 기대 로그

```
[2026-03-12T...] [PANEL_RESTORE] start channelId=123456789 panelFile=/path/to/state/discord-panel.json
[2026-03-12T...] [PANEL_RESTORE] existing panel message found messageId=... savedChannelId=...
[2026-03-12T...] [PANEL_RESTORE] editing existing panel message
[2026-03-12T...] [PANEL_RESTORE] success (edited)
```
또는 (저장된 메시지 없음/삭제/채널 불일치 시):
```
[2026-03-12T...] [PANEL_RESTORE] start channelId=...
[2026-03-12T...] [PANEL_RESTORE] not found (no state file)
[2026-03-12T...] [PANEL_RESTORE] sending new panel message
[2026-03-12T...] [PANEL_RESTORE] success (new message)
```
이후 재기동 안내 메시지가 전송되고, 그 안내 문구에 "패널 상태 : 복구 완료" 또는 "복구 실패 (로그 확인)"가 포함됨.

## 5) 검증 포인트

- 재기동 후 Discord 채널에 **두 개의 메시지**가 구분되어 있는가: (1) 재기동 안내 텍스트, (2) 역할 A/B/C 버튼이 붙은 통제 패널.
- 패널 메시지에 **content(역할 A/B/C 설명)** 와 **components(5 row 버튼)** 가 모두 붙어 있는가.
- 저장된 messageId가 없거나, 채널이 바뀌었거나, 메시지가 삭제된 경우 **새 패널 메시지가 전송**되고, 로그에 `[PANEL_RESTORE] sending new panel message` 및 `success (new message)`가 찍히는가.
- "패널 상태 : 복구 완료"는 **restorePanel()이 true를 반환한 경우에만** 재기동 안내 메시지에 표시되는가.
- 로그에 `[PANEL_RESTORE] start`, `existing panel message found`/`not found`, `editing`/`sending new`, `success`/`failure`가 순서대로 찍히는가.
