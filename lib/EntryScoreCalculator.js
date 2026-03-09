/**
 * EntryScoreCalculator - Entry Score 객체 지향 계산기
 * - Final_Score = Σ (항목별 충족 여부 0|1 × 사용자 가중치)
 * - 향후 지표 추가 시 indicators 배열에 { id, weightKey, satisfies } 만 넣으면 확장
 * - 학습: 배열로 지표를 정의해 루프로 합산하면 새 지표 추가 시 코드 수정 최소화
 */

const { getProfileNum } = require('../config.default');

/**
 * 기본 지표 정의
 * - id: 지표 식별자
 * - weightKey: 프로필에서 가중치를 읽을 키 (예: weight_price_break)
 * - satisfies: (snapshot, context) => boolean. context = { priceBreak, volSurge, p0Reason }
 */
const DEFAULT_INDICATORS = [
  {
    id: 'price_break',
    weightKey: 'weight_price_break',
    satisfies: (snapshot, context) => !!context.priceBreak
  },
  {
    id: 'vol_surge',
    weightKey: 'weight_vol_surge',
    satisfies: (snapshot, context) => !!context.volSurge
  },
  {
    id: 'obi',
    weightKey: 'weight_obi',
    satisfies: (snapshot, context) => {
      const obi = snapshot.obi_topN ?? 0;
      const th = context.obiThreshold ?? 0.1;
      return obi >= th;
    }
  },
  {
    id: 'strength',
    weightKey: 'weight_strength',
    satisfies: (snapshot, context) => {
      const strength = snapshot.strength_for_score ?? snapshot.strength_proxy_60s ?? 0;
      const th = context.strengthThreshold ?? 0.55;
      return strength >= th;
    }
  },
  {
    id: 'spread',
    weightKey: 'weight_spread',
    satisfies: (snapshot, context) => context.p0Reason !== 'BLOCK_SPREAD'
  },
  {
    id: 'depth',
    weightKey: 'weight_depth',
    satisfies: (snapshot, context) => context.p0Reason !== 'BLOCK_LIQUIDITY'
  },
  {
    id: 'kimp',
    weightKey: 'weight_kimp',
    satisfies: (snapshot, context) => context.p0Reason !== 'BLOCK_KIMP'
  }
];

class EntryScoreCalculator {
  /**
   * @param {Array<{ id: string, weightKey: string, satisfies: (snapshot, context) => boolean }>} [indicators] - 커스텀 지표 목록. 없으면 기본 7개 사용
   */
  constructor(indicators = null) {
    this.indicators = indicators != null ? indicators : [...DEFAULT_INDICATORS];
  }

  /**
   * 새 지표 추가 (확장성)
   * @param {string} id
   * @param {string} weightKey
   * @param {(snapshot: Object, context: Object) => boolean} satisfies
   */
  addIndicator(id, weightKey, satisfies) {
    this.indicators.push({ id, weightKey, satisfies });
  }

  /**
   * Entry Score 계산
   * @param {Object} profile - 전략 프로필 (가중치 키 포함)
   * @param {Object} snapshot - 호가/체결 스냅샷
   * @param {Object} context - { priceBreak, volSurge, p0Reason, obiThreshold?, strengthThreshold? }
   * @returns {number} 소수 둘째 자리까지 반올림
   */
  compute(profile, snapshot, context) {
    if (!profile || !snapshot) return 0;
    const ctx = {
      ...context,
      obiThreshold: getProfileNum(profile, 'obi_threshold', 0.1),
      strengthThreshold: getProfileNum(profile, 'strength_threshold', 0.55)
    };
    let score = 0;
    for (const ind of this.indicators) {
      const ok = ind.satisfies(snapshot, ctx);
      const weight = getProfileNum(profile, ind.weightKey, 0);
      score += ok ? weight : 0;
    }
    return Math.round(score * 100) / 100;
  }
}

/** 싱글톤 인스턴스 (기본 지표 사용) */
const defaultCalculator = new EntryScoreCalculator();

/**
 * 기본 계산기로 점수 계산 (기존 entryScoreWeighted 호환)
 * @param {Object} profile
 * @param {Object} snapshot
 * @param {boolean} priceBreak
 * @param {boolean} volSurge
 * @param {string|null} p0Reason
 * @returns {number}
 */
function computeScore(profile, snapshot, priceBreak, volSurge, p0Reason) {
  return defaultCalculator.compute(profile, snapshot, {
    priceBreak,
    volSurge,
    p0Reason: p0Reason || null
  });
}

module.exports = {
  EntryScoreCalculator,
  DEFAULT_INDICATORS,
  defaultCalculator,
  computeScore
};
