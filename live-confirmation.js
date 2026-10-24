'use strict';
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const RISK_KEYS = ['baseStake', 'maxStake', 'maxLoss', 'takeProfit', 'maxTrades', 'maxConsecutiveLosses', 'useMartingale', 'martingaleFactor', 'maxMartingaleSteps'];
const ANALYSIS_KEYS = ['emaPeriod', 'rsiPeriod', 'rsiLevel', 'crossWindow', 'useAdxFilter', 'adxPeriod', 'adxMin', 'atrPeriod', 'atrStopMult', 'atrTargetMult', 'noRepeatDirection'];
function riskSettings(strategy) { return Object.fromEntries(RISK_KEYS.map(key => [key, strategy.config[key]])); }
function analysisSettings(strategy) {
  const c = strategy.config;
  return { granularity: c.granularity, ...Object.fromEntries(ANALYSIS_KEYS.map(key => [key, c[key]])), macd: { fast: 12, slow: 26, signal: 9 }, closedCandleOnly: true };
}
class LiveConfirmation {
  constructor(accountId, mode = 'real') {
    if (!['real', 'demo'].includes(mode)) throw new Error('Confirmation mode must be real or demo.');
    this.accountId = accountId; this.mode = mode; this.clear();
  }
  clear() { this.challenge = null; }
  details(strategy) {
    const c = strategy.config, s = strategy.snapshot();
    return { mode: this.mode, accountId: this.accountId, currency: c.currency,
      symbol: c.symbol, granularity: c.granularity, duration: c.duration, durationUnit: c.durationUnit,
      riskLimits: riskSettings(strategy), analysisSettings: analysisSettings(strategy), nextStake: s.stake,
      session: { sessionProfit: s.sessionProfit, tradesCount: s.tradesCount, lossStreak: s.lossStreak },
      confirmation: this.mode === 'real'
        ? 'I CONFIRM REAL MONEY TRADING AND ACCEPT THESE EXACT MARKET, ANALYSIS, STAKE AND RISK SETTINGS'
        : 'I CONFIRM DEMO TRADING WITH VIRTUAL FUNDS AND ACCEPT THESE EXACT MARKET, ANALYSIS, STAKE AND RISK SETTINGS' };
  }
  issue(strategy) {
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    this.challenge = { ...this.details(strategy), nonce: crypto.randomBytes(32).toString('hex'), expiresAt };
    return structuredClone(this.challenge);
  }
  consume(body, strategy) {
    const expected = this.challenge;
    this.clear();
    if (!expected || Date.parse(expected.expiresAt) <= Date.now() ||
        !isDeepStrictEqual(body, expected) || !isDeepStrictEqual(this.details(strategy),
          Object.fromEntries(Object.entries(expected).filter(([key]) => !['nonce', 'expiresAt'].includes(key))))) {
      throw new Error(`A fresh authenticated ${this.mode === 'real' ? 'real-money' : 'Demo'} confirmation with the exact account, market, analysis, stake and risk settings is required. GET /confirmation?mode=${this.mode}, review it, then POST its complete JSON to /start?mode=${this.mode}.`);
    }
    return expected.riskLimits;
  }
}
module.exports = { LiveConfirmation, riskSettings, analysisSettings };
