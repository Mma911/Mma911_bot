'use strict';
const SETTINGS_KEYS = Object.freeze([
  'symbol', 'granularity', 'duration', 'durationUnit', 'baseStake', 'useMartingale',
  'martingaleFactor', 'maxMartingaleSteps', 'maxStake', 'maxLoss', 'takeProfit', 'maxTrades',
  'maxConsecutiveLosses', 'emaPeriod', 'rsiPeriod', 'rsiLevel', 'crossWindow',
  'useAdxFilter', 'adxPeriod', 'adxMin', 'atrPeriod', 'atrStopMult', 'atrTargetMult',
  'noRepeatDirection'
]);
const DURATION_UNITS = Object.freeze(['s', 'm', 'h', 'd', 't']);
const GRANULARITIES = Object.freeze([60, 120, 180, 300, 900, 1800, 3600, 14400, 86400]);
const SYMBOL_PATTERN = /^[A-Za-z0-9_]{2,40}$/;
const BOOLEAN_KEYS = Object.freeze(['useMartingale', 'useAdxFilter', 'noRepeatDirection']);
function settingsFromConfig(config) {
  return Object.fromEntries(SETTINGS_KEYS.map(key => [
    key, key === 'durationUnit' ? (config.durationUnit || config.duration_unit) : config[key]
  ]));
}
function normalizeSettings(input, currentConfig) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Settings must be a JSON object.');
  const unknown = Object.keys(input).filter(key => !SETTINGS_KEYS.includes(key));
  if (unknown.length) throw new Error(`Unsupported settings field: ${unknown[0]}.`);
  const next = { ...settingsFromConfig(currentConfig), ...input };
  if (typeof next.symbol !== 'string' || !SYMBOL_PATTERN.test(next.symbol)) throw new Error('Market symbol is invalid.');
  if (!Number.isInteger(next.granularity) || !GRANULARITIES.includes(next.granularity)) {
    throw new Error('Analysis timeframe must be one of 60, 120, 180, 300, 900, 1800, 3600, 14400, or 86400 seconds.');
  }
  if (!Number.isInteger(next.duration) || next.duration < 1 || next.duration > 10000) throw new Error('Duration must be an integer from 1 to 10000.');
  if (!DURATION_UNITS.includes(next.durationUnit)) throw new Error('Duration unit must be s, m, h, d, or t.');
  for (const key of BOOLEAN_KEYS) if (typeof next[key] !== 'boolean') throw new Error(`${key} must be true or false.`);
  const positive = (key, max = 1000000) => {
    if (typeof next[key] !== 'number' || !Number.isFinite(next[key]) || next[key] <= 0 || next[key] > max) {
      throw new Error(`${key} must be a number greater than 0 and no greater than ${max}.`);
    }
  };
  positive('baseStake', 100000); positive('maxStake', 100000);
  positive('maxLoss', 1000000); positive('takeProfit', 1000000);
  if (next.maxStake < next.baseStake) throw new Error('maxStake must be at least baseStake.');
  if (typeof next.martingaleFactor !== 'number' || !Number.isFinite(next.martingaleFactor) || next.martingaleFactor < 1 || next.martingaleFactor > 5) {
    throw new Error('martingaleFactor must be between 1 and 5.');
  }
  if (!Number.isInteger(next.maxMartingaleSteps) || next.maxMartingaleSteps < 0 || next.maxMartingaleSteps > 10) {
    throw new Error('maxMartingaleSteps must be an integer from 0 to 10.');
  }
  if (!Number.isInteger(next.maxTrades) || next.maxTrades < 1 || next.maxTrades > 10000) throw new Error('maxTrades must be an integer from 1 to 10000.');
  if (!Number.isInteger(next.maxConsecutiveLosses) || next.maxConsecutiveLosses < 1 || next.maxConsecutiveLosses > 20) {
    throw new Error('maxConsecutiveLosses must be an integer from 1 to 20.');
  }
  const integerRanges = { emaPeriod: [2, 250], rsiPeriod: [2, 50], crossWindow: [1, 10], adxPeriod: [2, 50], atrPeriod: [2, 50] };
  for (const [key, [min, max]] of Object.entries(integerRanges)) {
    if (!Number.isInteger(next[key]) || next[key] < min || next[key] > max) throw new Error(`${key} must be an integer from ${min} to ${max}.`);
  }
  if (typeof next.rsiLevel !== 'number' || !Number.isFinite(next.rsiLevel) || next.rsiLevel <= 0 || next.rsiLevel >= 100) {
    throw new Error('rsiLevel must be greater than 0 and less than 100.');
  }
  if (typeof next.adxMin !== 'number' || !Number.isFinite(next.adxMin) || next.adxMin < 0 || next.adxMin > 100) {
    throw new Error('adxMin must be between 0 and 100.');
  }
  positive('atrStopMult', 100); positive('atrTargetMult', 100);
  return next;
}
function nextStakeFor(settings, lossStreak) {
  const steps = Math.max(0, Number.isInteger(lossStreak) ? lossStreak : 0);
  const progressionSteps = settings.useMartingale ? Math.min(steps, settings.maxMartingaleSteps) : 0;
  const stake = settings.baseStake * Math.pow(settings.useMartingale ? settings.martingaleFactor : 1, progressionSteps);
  if (!Number.isFinite(stake)) throw new Error('Martingale progression exceeds the supported numeric range.');
  if (stake > settings.maxStake + 1e-9) throw new Error('Current next stake exceeds maxStake; adjust the risk settings before saving.');
  return stake;
}
module.exports = { SETTINGS_KEYS, DURATION_UNITS, GRANULARITIES, settingsFromConfig, normalizeSettings, nextStakeFor };
