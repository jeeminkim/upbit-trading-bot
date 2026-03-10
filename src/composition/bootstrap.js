/**
 * Composition Root — 엔진 DI 및 조립
 * 단계적 이관: 현재는 SignalEngine(ScalpStrategy)만 조립. server.js에서 require하여 사용.
 */

const path = require('path');
const SignalEngine = require('../domain/signal/SignalEngine');
const SignalNormalizer = require('../domain/signal/SignalNormalizer');
const ScalpStrategy = require('../domain/signal/strategies/ScalpStrategy');

/**
 * @returns {{ signalEngine: import('../domain/signal/SignalEngine') }}
 */
function bootstrap() {
  const signalEngine = new SignalEngine([ScalpStrategy], SignalNormalizer);
  return { signalEngine };
}

module.exports = { bootstrap };
