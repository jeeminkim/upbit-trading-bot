/**
 * Re-export for lib/strategy/edge/* and lib/strategy/* (require('../../config.default') → lib/config.default)
 * Config source of truth: dashboard/config.default.js (this file only re-exports the same module reference).
 * 모든 edge 관련 모듈은 동일 config 객체를 참조함. 설정값 불일치 없음.
 */
module.exports = require('../config.default');
