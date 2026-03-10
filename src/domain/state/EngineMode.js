/**
 * 엔진 운영 모드 — 429 pause 세분화 및 점진 복귀용
 * NORMAL: 정상 매매·시세 조회
 * EMERGENCY_PAUSE: 주문 금지, 시세 조회 최소화, 대시보드만 허용
 * RECOVERY: pause 해제 직후 30초간 저빈도(주문 금지, 시세 간격 확대)
 */
const NORMAL = 'NORMAL';
const EMERGENCY_PAUSE = 'EMERGENCY_PAUSE';
const RECOVERY = 'RECOVERY';

module.exports = {
  NORMAL,
  EMERGENCY_PAUSE,
  RECOVERY
};
