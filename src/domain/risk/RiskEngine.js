/**
 * RiskEngine — SignalDecision → RiskVerdict (MarketQualityGate + ExposurePolicy)
 */

const MarketQualityGate = require('./MarketQualityGate');
const ExposurePolicy = require('./ExposurePolicy');

/**
 * @param {import('./MarketQualityGate')} marketQualityGate
 * @param {import('./ExposurePolicy')} exposurePolicy
 */
function RiskEngine(marketQualityGate, exposurePolicy) {
  this.marketQualityGate = marketQualityGate || MarketQualityGate;
  this.exposurePolicy = exposurePolicy || ExposurePolicy;
}

/**
 * @param {import('../../shared/types/Signal').SignalDecision} decision
 * @param {Object} context - { snapshot, profile?, assets, accounts, budgetKrw? }
 * @returns {import('../../shared/types/Risk').RiskVerdict}
 */
RiskEngine.prototype.evaluate = function evaluate(decision, context) {
  const reasons = [];
  if (!decision || decision.side !== 'LONG') {
    return { allowed: false, reasons: ['NOT_LONG'] };
  }

  const snapshot = context?.snapshot;
  const profile = context?.profile;
  const mq = this.marketQualityGate.check(snapshot, profile);
  if (!mq.allowed) {
    reasons.push(mq.reason || 'MARKET_QUALITY');
    return { allowed: false, reasons };
  }

  const assets = context?.assets;
  const accounts = context?.accounts || [];
  const budgetKrw = context?.budgetKrw ?? 0;
  const ep = this.exposurePolicy.check(accounts, assets, decision.market, budgetKrw);
  if (!ep.allowed) {
    return { allowed: false, reasons: ep.reasons?.length ? ep.reasons : ['EXPOSURE'] };
  }

  return { allowed: true, reasons: [] };
};

module.exports = RiskEngine;
