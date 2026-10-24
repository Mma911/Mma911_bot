'use strict';
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const RISK_KEYS = ['baseStake', 'maxStake', 'maxLoss', 'takeProfit', 'maxTrades', 'maxConsecutiveLosses', 'useMartingale', 'martingaleFactor'];
function riskSettings(strategy) {
  return Object.fromEntries(RISK_KEYS.map(key => [key, strategy.config[key]]));
}
class LiveConfirmation {
  constructor(accountId) { this.accountId = accountId; this.clear(); }
  clear() { this.challenge = null; }
  details(strategy) {
    const c = strategy.config, s = strategy.snapshot();
    return { mode: 'real', accountId: this.accountId, currency: c.currency,
      symbol: c.symbol, granularity: c.granularity, duration: c.duration, durationUnit: c.durationUnit,
      riskLimits: riskSettings(strategy), nextStake: s.stake,
      session: { sessionProfit: s.sessionProfit, tradesCount: s.tradesCount, lossStreak: s.lossStreak },
      confirmation: 'I CONFIRM REAL MONEY TRADING AND ACCEPT THESE EXACT STAKE AND RISK LIMITS' };
  }
  issue(strategy) {
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    this.challenge = { ...this.details(strategy), nonce: crypto.randomBytes(32).toString('hex'), expiresAt };
    return structuredClone(this.challenge);
  }
  consume(body, strategy) {
    const expected = this.challenge;
    this.clear(); // Every attempt consumes the challenge; never replay a start request.
    if (!expected || Date.parse(expected.expiresAt) <= Date.now() ||
        !isDeepStrictEqual(body, expected) || !isDeepStrictEqual(this.details(strategy),
          Object.fromEntries(Object.entries(expected).filter(([key]) => !['nonce', 'expiresAt'].includes(key))))) {
      throw new Error('A fresh authenticated real-money confirmation with the exact account, stake and risk limits is required. GET /confirmation, review it, then POST its complete JSON to /start.');
    }
    return expected.riskLimits;
  }
}
module.exports = { LiveConfirmation, riskSettings };
