/**
 * shared/types — 엔진 간 데이터 계약 통합 export
 * 모든 엔진은 이 타입 정의를 준수해야 함.
 */
require('./Market.js');
require('./Signal.js');
require('./Risk.js');
require('./Execution.js');
require('./Position.js');

module.exports = {
  // 타입은 JSDoc으로 정의되어 있음. 다른 모듈에서 사용 시:
  // @typedef { import('../shared/types/Market').MarketSnapshot } MarketSnapshot
  // 또는 require('../shared/types/Market') 후 JSDoc 참조
};
