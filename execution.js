'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { LiveConfirmation, riskSettings } = require('./live-confirmation');
const { settingsFromConfig, normalizeSettings } = require('./runtime-settings');

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length); let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) { const index = cursor++; if (index >= items.length) return; results[index] = await mapper(items[index]); }
  });
  await Promise.all(workers); return results;
}

class ExecutionEngine {
  constructor({ client, strategy, stateFile, accountId }) {
    this.client = client; this.strategy = strategy; this.stateFile = stateFile;
    this.confirmation = new LiveConfirmation(accountId); this.approvedRisk = null;
    this.accountKey = crypto.createHash('sha256').update(accountId).digest('hex');
    this.enabled = false; this.ready = false; this.busy = false; this.generation = 0;
    this.connectionEpoch = 0; this.storageFault = false; this.marketSubscriptions = new Set(); this.retiredMarketSubscriptions = new Set(); this.marketCache = null;
    this.candles = []; this.pending = null; this.lastTrade = null; this.tradeHistory = []; this.lastTick = null;
    this.lastError = null; this.stopReason = 'Stopped on startup'; this.settledIds = [];
    this.load();
    client.on('connected', () => this.initialize().catch(e => this.fail(e)));
    client.on('disconnected', () => { this.connectionEpoch++; this.ready = false; this.stop('Connection lost; manual start required'); });
    client.on('warning', message => { this.lastError = message; this.ready = false; this.stop('Connection warning; manual confirmation required'); });
    client.on('message', message => {
      try { this.onMessage(message); } catch (error) { this.fail(error); }
    });
  }
  load() {
    if (!this.stateFile || !fs.existsSync(this.stateFile)) return;
    const saved = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
    if (![2, 3].includes(saved.version) || saved.mode !== 'real' || saved.accountKey !== this.accountKey) throw new Error('State file version/account mismatch; refusing startup.');
    if (saved.version === 3) {
      // Migrate v4.1 journals: newly exposed settings inherit the exact current strategy defaults.
      if (!saved.settings || typeof saved.settings !== 'object' || Array.isArray(saved.settings)) throw new Error('Persisted settings are invalid; refusing startup.');
      const settings = normalizeSettings(saved.settings, this.strategy.config);
      Object.assign(this.strategy.config, settings, { duration_unit: settings.durationUnit });
    }
    this.strategy.restoreState(saved.strategy);
    this.pending = saved.pending; this.lastTrade = saved.lastTrade; this.tradeHistory = Array.isArray(saved.tradeHistory) ? saved.tradeHistory.slice(-200) : [];
    this.settledIds = saved.settledIds || [];
  }
  persist() {
    try { this.writeState(); } catch (error) { this.storageFault = true; this.stop('Durable storage failure; restart and reconcile before trading'); throw error; }
  }
  writeState() {
    if (!this.stateFile) return;
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true, mode: 0o700 });
    const temporary = `${this.stateFile}.tmp`;
    const fd = fs.openSync(temporary, 'w', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify({ version: 3, mode: 'real', accountKey: this.accountKey, settings: settingsFromConfig(this.strategy.config), strategy: this.strategy.exportState(),
        pending: this.pending, lastTrade: this.lastTrade, tradeHistory: this.tradeHistory, settledIds: this.settledIds }, null, 2) + '\n');
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, this.stateFile);
    const dir = fs.openSync(path.dirname(this.stateFile), 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  }
  stop(reason = 'Stopped by operator') { this.enabled = false; this.approvedRisk = null; this.confirmation.clear(); this.generation++; this.stopReason = reason; }
  settings() {
    return { ...settingsFromConfig(this.strategy.config), stopped: !this.enabled, busy: this.busy,
      connected: this.client.connected, ready: this.ready, hasUnresolved: Boolean(this.pending) };
  }
  async markets() {
    if (!this.ready || !this.client.connected || !this.client.realAuthenticated) throw new Error('Connect and initialize the authenticated server session before loading markets.');
    if (this.marketCache && this.marketCache.expiresAt > Date.now()) { this.marketDiagnostics = this.marketCache.diagnostics; return structuredClone(this.marketCache.markets); }
    // Deriv's current schema removed product_type and renamed symbol/display fields.
    const response = await this.client.request({ active_symbols: 'brief', contract_type: ['CALL', 'PUT'] });
    if (!Array.isArray(response.active_symbols)) throw new Error('Deriv active_symbols response has no active_symbols array. Check server logs for the Deriv API error code and message.');
    const seen = new Set();
    const candidates = response.active_symbols.map(item => {
      if (!item || typeof item !== 'object') return null;
      const symbol = item.underlying_symbol || item.symbol;
      if (typeof symbol !== 'string' || !/^[A-Za-z0-9_]{2,40}$/.test(symbol) || seen.has(symbol)) return null;
      if (item.is_trading_suspended === true || item.is_trading_suspended === 1 || item.is_trading_suspended === '1') return null;
      seen.add(symbol);
      return { symbol, displayName: String(item.underlying_symbol_name || item.display_name || symbol), market: String(item.market || ''), submarket: String(item.submarket || item.subgroup || '') };
    }).filter(Boolean);
    const failures = []; let unsupportedCount = 0;
    const verified = await mapLimit(candidates, 4, async item => {
      try {
        const result = await this.client.request({ contracts_for: item.symbol });
        const available = result.contracts_for?.available;
        if (!Array.isArray(available)) { unsupportedCount++; return null; }
        const types = new Set(available.map(contract => contract?.contract_type));
        if (!types.has('CALL') || !types.has('PUT')) { unsupportedCount++; return null; }
        return item;
      } catch (error) {
        if (!this.client.connected || !this.client.realAuthenticated) throw error;
        failures.push({ symbol: item.symbol, code: error.code || null, message: String(error.message || 'Deriv request failed').slice(0, 240) });
        return null;
      }
    });
    if (!this.client.connected || !this.client.realAuthenticated) throw new Error('Deriv connection changed while validating markets.');
    const markets = verified.filter(Boolean).sort((a, b) => a.displayName.localeCompare(b.displayName));
    this.marketDiagnostics = { activeSymbolCount: response.active_symbols.length, candidateCount: candidates.length, verifiedCount: markets.length, unsupportedCount, failedCount: failures.length, sampleFailures: failures.slice(0, 5) };
    // Do not cache a blank list; allow an immediate retry after a transient API error.
    if (markets.length) this.marketCache = { markets, diagnostics: this.marketDiagnostics, expiresAt: Date.now() + 120000 };
    return structuredClone(markets);
  }
  async forgetMarketSubscriptions() {
    const ids = [...this.marketSubscriptions]; ids.forEach(id => this.retiredMarketSubscriptions.add(id)); this.marketSubscriptions.clear();
    await Promise.all(ids.map(id => this.client.request({ forget: id }).catch(() => null)));
  }
  async updateSettings(patch) {
    if (this.enabled || this.busy || this.pending) throw new Error('Settings can only change while stopped, idle, and with no open or unresolved contract.');
    if (this.storageFault) throw new Error('Durable storage failed; restart and reconcile before changing settings.');
    if (!this.ready || !this.client.connected || !this.client.realAuthenticated) throw new Error('Settings require a ready authenticated server connection.');
    if (!this.stateFile || !path.isAbsolute(this.stateFile)) throw new Error('A persistent absolute STATE_FILE is required to save cloud settings.');
    const settings = normalizeSettings(patch, this.strategy.config);
    this.busy = true;
    const previousSettings = settingsFromConfig(this.strategy.config);
    const previousState = this.strategy.exportState();
    let persisted = false;
    try {
      const markets = await this.markets();
      if (!markets.some(item => item.symbol === settings.symbol)) throw new Error('Selected symbol is not currently active with both CALL and PUT options on Deriv.');
      this.strategy.applySettings(settings);
      this.persist(); persisted = true;
      await this.forgetMarketSubscriptions();
      this.ready = false; this.candles = []; this.lastTick = null; this.confirmation.clear();
      await this.initialize();
      return { ...this.settings(), busy: false };
    } catch (error) {
      if (!persisted) {
        Object.assign(this.strategy.config, previousSettings, { duration_unit: previousSettings.durationUnit });
        this.strategy.restoreState(previousState);
      } else {
        this.lastError = error.message;
        this.stop('Settings saved, but market initialization failed; trading remains stopped');
        throw new Error(`Settings saved, but market initialization failed; trading remains stopped: ${error.message}`);
      }
      throw error;
    } finally { this.busy = false; }
  }
  fail(error) { this.lastError = error.message; this.stop('Error: ' + error.message); }
  async initialize() {
    this.ready = false; this.stop('Connected; manual start required'); this.candles = [];
    const epoch = ++this.connectionEpoch;
    const assertCurrent = () => { if (epoch !== this.connectionEpoch || !this.client.connected) throw new Error('Connection changed during initialization.'); };
    const cfg = this.strategy.config;
    const balance = await this.client.request({ balance: 1 });
    assertCurrent();
    if (balance.balance?.currency !== cfg.currency) throw new Error(`Strategy requires account currency ${cfg.currency}.`);
    const history = await this.client.request({ ticks_history: cfg.symbol, style: 'candles', granularity: cfg.granularity,
      count: 1000, end: 'latest', subscribe: 1 });
    assertCurrent();
    if (!Array.isArray(history.candles) || !history.candles.length) throw new Error('Deriv returned no candle history.');
    if (history.subscription?.id) this.marketSubscriptions.add(history.subscription.id);
    this.candles = history.candles.map(c => this.normalizeCandle(c));
    const tickResponse = await this.client.request({ ticks: cfg.symbol, subscribe: 1 });
    if (tickResponse.subscription?.id) this.marketSubscriptions.add(tickResponse.subscription.id);
    if (this.strategy.setPrecision) this.strategy.setPrecision(tickResponse.tick?.pip_size);
    assertCurrent();
    if (this.pending?.contractId) await this.monitor(this.pending.contractId);
    assertCurrent();
    this.ready = true;
  }
  normalizeCandle(c) {
    const value = { epoch: Number(c.open_time ?? c.epoch), open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close) };
    if (!Object.values(value).every(Number.isFinite) || value.high < value.low) throw new Error('Invalid OHLC data.');
    return value;
  }
  onMessage(message) {
    if (message.error) {
      // API request errors are also delivered to the awaiting request promise.
      if (['ohlc', 'tick', 'proposal_open_contract'].includes(message.msg_type)) this.fail(new Error(message.error.message || 'Subscription failed.'));
      return;
    }
    const subscriptionId = message.subscription?.id;
    if (subscriptionId && this.retiredMarketSubscriptions.has(subscriptionId)) return;
    if (subscriptionId && ['ohlc', 'tick'].includes(message.msg_type)) this.marketSubscriptions.add(subscriptionId);
    if (message.tick && message.tick.symbol === this.strategy.config.symbol) this.lastTick = { symbol: message.tick.symbol, quote: Number(message.tick.quote), epoch: Number(message.tick.epoch) };
    if (message.ohlc) {
      if (message.ohlc.symbol && message.ohlc.symbol !== this.strategy.config.symbol) return;
      const c = this.normalizeCandle(message.ohlc);
      const last = this.candles.at(-1);
      if (last && c.epoch < last.epoch) return;
      if (last?.epoch === c.epoch) this.candles[this.candles.length - 1] = c;
      else this.candles.push(c);
      this.candles = this.candles.slice(-1000);
      this.lastCandleReceivedAt = Date.now();
      this.onMarket().catch(error => this.fail(error));
    }
    if (message.proposal_open_contract) this.onContract(message.proposal_open_contract, message.subscription?.id);
  }
  proposal(direction, stake) {
    const c = this.strategy.config;
    return { proposal: 1, amount: stake, basis: 'stake', contract_type: direction,
      currency: c.currency, duration: c.duration, duration_unit: c.durationUnit, underlying_symbol: c.symbol };
  }
  issueConfirmation() {
    if (this.enabled || !this.ready || !this.client.connected || !this.client.realAuthenticated || this.pending || this.busy || this.storageFault) throw new Error('Confirmation requires a stopped, ready, real-account connection with no unresolved purchase or storage fault.');
    if (!this.strategy.canTrade()) throw new Error('Strategy session risk limit reached.');
    return this.confirmation.issue(this.strategy);
  }
  async start(confirmation) {
    const approvedRisk = this.confirmation.consume(confirmation, this.strategy);
    if (this.storageFault) throw new Error('Durable storage failed; restart and reconcile before trading.');
    if (this.enabled) throw new Error('Trading is already enabled. Stop first.');
    if (!this.client.connected || !this.client.realAuthenticated || !this.ready) throw new Error('Authenticated real-account connection and candle history must be ready.');
    if (this.pending) throw new Error('An open contract or uncertain purchase exists; no new purchase is allowed.');
    if (this.busy) throw new Error('An operation is still in progress.');
    if (!this.strategy.canTrade()) throw new Error('Strategy session risk limit reached.');
    // Read-only preflight: keep original duration, do not silently lengthen an unsupported contract.
    const version = ++this.generation;
    this.busy = true;
    try {
      this.persist(); // Verify durable storage before enabling, even before the first signal.
      const stake = this.strategy.snapshot().stake;
      for (const direction of ['CALL', 'PUT']) {
        const result = await this.client.request(this.proposal(direction, stake));
        if (!result.proposal?.id) throw new Error('Missing proposal ID during preflight.');
      }
      if (version !== this.generation || !this.client.connected || !this.client.realAuthenticated) throw new Error('Start cancelled.');
      this.approvedRisk = approvedRisk; this.enabled = true; this.stopReason = null; this.lastError = null;
      return this.status();
    } finally { this.busy = false; }
  }
  async onMarket() {
    if (!this.enabled || !this.ready || this.busy || this.pending) return;
    if (!this.client.realAuthenticated || !isDeepStrictEqual(this.approvedRisk, riskSettings(this.strategy))) { this.stop('Real authentication or approved risk limits changed'); return; }
    if (!this.strategy.canTrade()) { this.stop('Strategy session risk limit reached'); return; }
    const current = this.candles.at(-1);
    // Do not trade stale history, including the Friday close during a weekend.
    if (!current || Date.now() / 1000 - current.epoch > this.strategy.config.granularity * 2) return;
    this.busy = true;
    const version = this.generation;
    try {
      const signal = this.strategy.evaluate(this.candles);
      this.persist();
      if (!signal.direction) return;
      const stake = Number(signal.stake);
      if (!(stake > 0) || !Number.isFinite(stake) || stake > this.approvedRisk.maxStake || stake !== this.strategy.snapshot().stake) throw new Error('Invalid strategy stake.');
      const response = await this.client.request(this.proposal(signal.direction, stake));
      if (!this.enabled || version !== this.generation || !this.client.connected || !this.client.realAuthenticated) return;
      const p = response.proposal;
      if (!p?.id) throw new Error('Deriv did not return a proposal ID.');
      const price = p.ask_price == null ? stake : Number(p.ask_price);
      if (!(price > 0) || price > stake + 1e-8) throw new Error('Proposal price exceeds allowed stake.');
      // Persist intent BEFORE submitting buy. Never retry automatically if its acknowledgement is lost.
      this.pending = { phase: 'buy-intent', proposalId: p.id, direction: signal.direction, stake,
        submittedAt: new Date().toISOString(), candleEpoch: current.epoch };
      this.persist();
      let bought;
      try { bought = await this.client.request({ buy: String(p.id), price: stake }); }
      catch (error) {
        if (error.apiError) { this.pending = null; this.persist(); }
        else { this.pending.phase = 'uncertain'; this.persist(); }
        throw error;
      }
      const id = Number(bought.buy?.contract_id);
      if (!Number.isSafeInteger(id) || id <= 0) { this.pending.phase = 'uncertain'; this.persist(); throw new Error('Buy acknowledgement lacks contract ID. Reconcile before any restart.'); }
      this.strategy.setLastDirection(signal.direction);
      this.pending = { ...this.pending, phase: 'open', contractId: id }; this.persist();
      await this.monitor(id);
    } finally { this.busy = false; }
  }
  async monitor(id) {
    await this.client.request({ proposal_open_contract: 1, contract_id: id, subscribe: 1 });
  }
  onContract(contract, subscriptionId) {
    const id = Number(contract.contract_id);
    if (!this.pending || id !== this.pending.contractId || this.settledIds.includes(id)) return;
    if (!(contract.is_sold === 1 || contract.is_sold === true || contract.is_sold === '1')) return;
    const profit = Number(contract.profit);
    if (!Number.isFinite(profit) || contract.profit == null) throw new Error('Settled contract has no valid profit; reconciliation required.');
    this.strategy.settled(profit);
    this.lastTrade = { ...this.pending, profit, status: contract.status, settledAt: new Date().toISOString() };
    this.tradeHistory = [...this.tradeHistory.slice(-199), this.lastTrade];
    this.pending = null; this.settledIds = [...this.settledIds.slice(-199), id]; this.persist();
    if (!this.strategy.canTrade()) this.stop('Strategy session risk limit reached');
    if (subscriptionId) this.client.request({ forget: subscriptionId }).catch(() => {});
  }
  async reconcile(contractId) {
    if (!this.ready || this.enabled || this.busy || !this.pending || this.pending.contractId) throw new Error('Reconciliation requires a stopped, ready service with an uncertain purchase.');
    const id = Number(contractId);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('A valid contractId is required.');
    this.busy = true;
    try {
      const response = await this.client.request({ proposal_open_contract: 1, contract_id: id });
      const c = response.proposal_open_contract;
      const p = this.pending;
      const purchaseTime = Date.parse(p.submittedAt) / 1000;
      if (!c || Number(c.contract_id) !== id || !Number.isFinite(purchaseTime) || !Number.isFinite(Number(c.buy_price)) || c.buy_price == null || String(c.underlying ?? c.underlying_symbol) !== this.strategy.config.symbol || c.contract_type !== p.direction ||
          Math.abs(Number(c.buy_price) - p.stake) > 1e-6 || !Number.isFinite(Number(c.purchase_time)) || Math.abs(Number(c.purchase_time) - purchaseTime) > 120) {
        throw new Error('Contract does not match the recorded uncertain purchase; refusing association.');
      }
      this.strategy.setLastDirection(p.direction);
      this.pending = { ...p, contractId: id, phase: 'open' }; this.persist();
      this.onContract(c);
      if (this.pending) await this.monitor(id);
      return this.status();
    } finally { this.busy = false; }
  }
  status() {
    return { connected: this.client.connected, ready: this.ready, tradingEnabled: this.enabled,
      mode: 'real', realAuthenticated: this.client.realAuthenticated, confirmationRequired: !this.enabled, storageFault: this.storageFault, symbol: this.strategy.config.symbol, config: this.strategy.config, settings: this.settings(),
      strategy: this.strategy.snapshot(), candleCount: this.candles.length, lastTick: this.lastTick,
      tradeCount: this.tradeHistory.length, pnl: this.strategy.snapshot().sessionProfit,
      pending: this.pending, lastTrade: this.lastTrade, lastError: this.lastError, stopReason: this.stopReason };
  }
  history(limit = 50) {
    const count = Math.min(200, Math.max(1, Number.isInteger(limit) ? limit : 50));
    return this.tradeHistory.slice(-count).reverse();
  }
}
module.exports = { ExecutionEngine };
