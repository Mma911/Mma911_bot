'use strict';

const SETTINGS_KEYS = Object.freeze([
  'symbol', 'duration', 'durationUnit', 'baseStake', 'useMartingale',
  'martingaleFactor', 'maxStake', 'maxLoss', 'takeProfit', 'maxTrades',
  'maxConsecutiveLosses'
]);
const DURATION_UNITS = Object.freeze(['s', 'm', 'h', 'd', 't']);
const SYMBOL_PATTERN = /^[A-Za-z0-9_]{2,40}$/;

function settingsFromConfig(config) {
  return Object.fromEntries(SETTINGS_KEYS.map(key => [key,
    key === 'durationUnit' ? (config.durationUnit || config.duration_unit) : config[key]]));
}

function normalizeSettings(input, currentConfig) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Settings must be a JSON object.');
  const unknown = Object.keys(input).filter(key => !SETTINGS_KEYS.includes(key));
  if (unknown.length) throw new Error(`Unsupported settings field: ${unknown[0]}.`);
  const current = settingsFromConfig(currentConfig);
  const next = { ...current, ...input };
  if (typeof next.symbol !== 'string' || !SYMBOL_PATTERN.test(next.symbol)) throw new Error('Market symbol is invalid.');
  if (!Number.isInteger(next.duration) || next.duration < 1 || next.duration > 10000) throw new Error('Duration must be an integer from 1 to 10000.');
  if (!DURATION_UNITS.includes(next.durationUnit)) throw new Error('Duration unit must be s, m, h, d, or t.');
  if (typeof next.useMartingale !== 'boolean') throw new Error('useMartingale must be true or false.');
  const positive = (key, max = 1000000) => {
    if (typeof next[key] !== 'number' || !Number.isFinite(next[key]) || next[key] <= 0 || next[key] > max) {
      throw new Error(`${key} must be a number greater than 0 and no greater than ${max}.`);
    }
  };
  positive('baseStake', 100000);
  positive('maxStake', 100000);
  positive('maxLoss', 1000000);
  positive('takeProfit', 1000000);
  if (next.maxStake < next.baseStake) throw new Error('maxStake must be at least baseStake.');
  if (typeof next.martingaleFactor !== 'number' || !Number.isFinite(next.martingaleFactor) || next.martingaleFactor < 1 || next.martingaleFactor > 5) {
    throw new Error('martingaleFactor must be between 1 and 5.');
  }
  if (!Number.isInteger(next.maxTrades) || next.maxTrades < 1 || next.maxTrades > 10000) throw new Error('maxTrades must be an integer from 1 to 10000.');
  if (!Number.isInteger(next.maxConsecutiveLosses) || next.maxConsecutiveLosses < 1 || next.maxConsecutiveLosses > 20) {
    throw new Error('maxConsecutiveLosses must be an integer from 1 to 20.');
  }
  return next;
}

function nextStakeFor(settings, lossStreak) {
  const steps = Math.max(0, Number.isInteger(lossStreak) ? lossStreak : 0);
  const stake = settings.useMartingale ? settings.baseStake * Math.pow(settings.martingaleFactor, steps) : settings.baseStake;
  if (!Number.isFinite(stake)) throw new Error('Martingale progression exceeds the supported numeric range.');
  if (stake > settings.maxStake + 1e-9) throw new Error('Current next stake exceeds maxStake; adjust the risk settings before saving.');
  return stake;
}

module.exports = { SETTINGS_KEYS, DURATION_UNITS, settingsFromConfig, normalizeSettings, nextStakeFor };
