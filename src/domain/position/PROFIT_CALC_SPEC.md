# PositionEngine 수익률 계산 계승 명세

구조 변경 시 변수명이 바뀌어 수익률이 0%로 보이지 않도록, **업비트 방식(KRW 제외)** 을 그대로 유지해야 함.

## 현재 server.js 기준 (getProfitPct, buildCurrentStateEmbed)

- **총매수**: `assets.totalBuyKrwForCoins ?? assets.totalBuyKrw` (보유 코인만, KRW 제외)
- **평가**: `assets.evaluationKrwForCoins` (코인 평가금 합계)
- **수익률(%)**: `(evaluationKrwForCoins - totalBuyKrwForCoins) / totalBuyKrwForCoins * 100`
- 총매수 0이면 0% 반환.
- APENFT·PURSE·잡코인 제외는 `lib/upbit.js` summarizeAccounts 쪽에서 처리.

## PositionEngine 구현 시

- `PositionEngine` 또는 집계 레이어에서 위와 동일한 필드명/계산식을 사용.
- `totalBuyKrwForCoins`, `evaluationKrwForCoins` 를 노출해 대시보드/디스코드 임베드가 그대로 동작하도록 할 것.
- **공통 함수**: `src/shared/utils/math.js` 의 `calculateUpbitProfitPct(totalBuyKrw, totalEvalKrw)` 사용. 분모는 코인 총매수만, 보유 KRW/전체자산 사용 금지.

## 매수/매도 직후

- 수익률 표시 전 반드시 `fetchAssets()` 실행하여 업비트 실제 평단가·수량 반영 후 `getProfitPct(assets)` 호출.
