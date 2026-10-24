'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { LiveConfirmation, riskSettings } = require('./live-confirmation');

class ExecutionEngine {
  constructor({ client, strategy, stateFile, accountId }) {
    this.client = client; this.strategy = strategy; this.stateFile = stateFile;
    this.confirmation = new LiveConfirmation(accountId); this.approvedRisk = null;
    this.accountKey = crypto.createHash('sha256').update(accountId).digest('hex');
    this.enabled = false; this.ready = false; this.busy = false; this.generation = 0;
    this.connectionEpoch = 0; this.storageFault = false;
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
    if (saved.version !== 2 || saved.mode !== 'real' || saved.accountKey !== this.accountKey) throw new Error('State file version/account mismatch; refusing startup.');
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
      fs.writeFileSync(fd, JSON.stringify({ version: 2, mode: 'real', accountKey: this.accountKey, strategy: this.strategy.exportState(),
        pending: this.pending, lastTrade: this.lastTrade, tradeHistory: this.tradeHistory, settledIds: this.settledIds }, null, 2) + '\n');
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, this.stateFile);
    const dir = fs.openSync(path.dirname(this.stateFile), 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  }
  stop(reason = 'Stopped by operator') { this.enabled = false; this.approvedRisk = null; this.confirmation.clear(); this.generation++; this.stopReason = reason; }
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
    this.candles = history.candles.map(c => this.normalizeCandle(c));
    const tickResponse = await this.client.request({ ticks: cfg.symbol, subscribe: 1 });
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
    if (message.tick) this.lastTick = { symbol: message.tick.symbol, quote: Number(message.tick.quote), epoch: Number(message.tick.epoch) };
    if (message.ohlc) {
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
      mode: 'real', realAuthenticated: this.client.realAuthenticated, confirmationRequired: !this.enabled, storageFault: this.storageFault, symbol: this.strategy.config.symbol, config: this.strategy.config,
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
