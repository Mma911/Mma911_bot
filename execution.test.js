'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ExecutionEngine, historicalDirectionalEvaluation } = require('../execution');
const { validateRealUrl, validateDemoUrl, DerivClient } = require('../deriv-client');
const { createApp, createEngines } = require('../server');
class FakeClient extends EventEmitter {
  constructor() { super(); this.connected = true; this.realAuthenticated = true; this.requests = []; }
  async connect() { this.connected = true; this.realAuthenticated = true; }
  async request(payload) {
    this.requests.push(payload);
    if (this.handler) return this.handler(payload);
    if (payload.proposal) return { proposal: { id: 'quote', ask_price: '1' } };
    if (payload.buy) return { buy: { contract_id: 123 } };
    if (payload.balance) return { balance: { currency: 'USD' } };
    if (payload.ticks_history) return { candles: [candle()] };
    return {};
  }
}
async function start(engine) { return engine.start(engine.issueConfirmation()); }
function candle() { return { epoch: Math.floor(Date.now()/60000)*60, open: 1, high: 2, low: 0.5, close: 1 }; }
function fakeStrategy() {
  return { config: { ...require('../strategy').DEFAULTS, symbol: 'frxEURUSD', currency: 'USD', granularity: 60, duration: 1, durationUnit: 'm' },
    profit: 0, count: 0, canTrade() { return this.count < 20; }, evaluate() { return { direction: 'CALL', stake: 1 }; },
    snapshot() { return { stake: 1, sessionProfit: this.profit, tradesCount: this.count, lossStreak: 0 }; },
    settled(p) { this.profit += p; this.count++; }, setLastDirection(d) { this.direction = d; },
    exportState() { return { profit: this.profit, count: this.count }; }, restoreState(s) { this.profit = s.profit; this.count = s.count; } };
}
function fixture(stateFile) {
  const client = new FakeClient(), strategy = fakeStrategy();
  const engine = new ExecutionEngine({ client, strategy, stateFile, accountId: 'real-test' });
  engine.ready = true; engine.candles = [candle(), candle()];
  return { client, strategy, engine };
}
test('proposal -> buy -> monitoring -> settlement once', async () => {
  const { client, strategy, engine } = fixture();
  await start(engine);
  await Promise.all([engine.onMarket(), engine.onMarket(), engine.onMarket()]);
  assert.equal(client.requests.filter(x => x.buy).length, 1);
  assert.equal(engine.pending.contractId, 123);
  assert.ok(client.requests.some(x => x.proposal_open_contract && x.contract_id === 123));
  const sold = { proposal_open_contract: { contract_id: 123, is_sold: 1, profit: '0.85', status: 'won' } };
  engine.onMessage(sold); engine.onMessage(sold);
  assert.equal(strategy.count, 1); assert.equal(strategy.profit, 0.85); assert.equal(engine.pending, null);
});
test('stop during pricing prevents buy, and stop during start cancels enable', async () => {
  const { engine, client } = fixture(); await start(engine);
  let resolve; client.handler = () => new Promise(r => { resolve = r; });
  const pending = engine.onMarket(); engine.stop(); resolve({ proposal: { id: 'late', ask_price: 1 } }); await pending;
  assert.equal(client.requests.filter(x => x.buy).length, 0);
  const starting = start(engine); engine.stop();
  resolve({ proposal: { id: 'preflight1' } }); await new Promise(r => setImmediate(r));
  resolve({ proposal: { id: 'preflight2' } }); await assert.rejects(starting, /cancelled/);
  assert.equal(engine.enabled, false);
});
test('uncertain buy is journaled across restart and blocks any new buy', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scdp-test-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stateFile = path.join(dir, 'state.json');
  const { engine, client } = fixture(stateFile); await start(engine);
  client.handler = async p => { if (p.buy) throw new Error('lost acknowledgement'); return { proposal: { id: 'x', ask_price: 1 } }; };
  await assert.rejects(engine.onMarket(), /acknowledgement/);
  assert.equal(engine.pending.phase, 'uncertain');
  const restored = fixture(stateFile).engine;
  await assert.rejects(start(restored), /unresolved/);
  assert.equal(restored.pending.phase, 'uncertain');
});
test('explicit buy rejection clears intent, while disconnect stops execution', async () => {
  const { engine, client } = fixture(); await start(engine);
  client.handler = async p => { if (p.buy) { const e = new Error('rejected'); e.apiError = true; throw e; } return { proposal: { id: 'x', ask_price: 1 } }; };
  await assert.rejects(engine.onMarket(), /rejected/); assert.equal(engine.pending, null);
  client.emit('disconnected'); assert.equal(engine.enabled, false); assert.equal(engine.ready, false);
});
test('restart recovers and monitors an acknowledged contract', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scdp-test-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'state.json'); const original = fixture(file); await start(original.engine); await original.engine.onMarket();
  const recovered = fixture(file); await recovered.engine.initialize();
  assert.equal(recovered.engine.enabled, false);
  assert.ok(recovered.client.requests.some(x => x.proposal_open_contract && x.contract_id === 123));
  assert.equal(recovered.client.requests.filter(x => x.buy).length, 0);
});
test('stale candles and over-stake pricing never buy', async () => {
  const { engine, client } = fixture(); await start(engine);
  engine.candles = [{ ...candle(), epoch: 1 }]; await engine.onMarket();
  assert.equal(client.requests.filter(x => x.buy).length, 0);
  engine.candles = [candle()]; client.handler = async () => ({ proposal: { id: 'too-expensive', ask_price: 2 } });
  await assert.rejects(engine.onMarket(), /exceeds/); assert.equal(client.requests.filter(x => x.buy).length, 0);
});
test('Real URL validation still refuses Demo, spoofed and non-secure endpoints', () => {
  assert.ok(validateRealUrl('wss://api.derivws.com/trading/v1/options/ws/real?otp=test'));
  for (const value of ['wss://api.derivws.com/trading/v1/options/ws/demo?otp=test', 'wss://api.derivws.com/trading/v1/options/ws/real?otp=test&otp=second', 'wss://api.derivws.com/trading/v1/options/ws/real?otp=test#fragment', 'wss://api.derivws.com.evil.test/trading/v1/options/ws/demo?otp=test', 'ws://api.derivws.com/trading/v1/options/ws/demo?otp=test']) assert.throws(() => validateRealUrl(value));
  assert.ok(validateDemoUrl('wss://api.derivws.com/trading/v1/options/ws/demo?otp=test'));
  for (const value of ['wss://api.derivws.com/trading/v1/options/ws/real?otp=test', 'wss://api.derivws.com.evil.test/trading/v1/options/ws/demo?otp=test', 'ws://api.derivws.com/trading/v1/options/ws/demo?otp=test']) assert.throws(() => validateDemoUrl(value));
});
test('client correlates messages and preserves explicit API rejection', async () => {
  class FakeSocket extends EventEmitter {
    constructor() { super(); queueMicrotask(() => this.emit('open')); }
    send(raw) { const p = JSON.parse(raw); queueMicrotask(() => this.emit('message', Buffer.from(JSON.stringify({ req_id: p.req_id, error: { code: 'Denied', message: 'Denied' } })))); }
    close() { this.emit('close'); }
  }
  const client = new DerivClient({ appId: 'test', pat: 'not-a-real-token', accountId: 'real' }, {
    WebSocket: FakeSocket, fetch: async () => ({ ok: true, json: async () => ({ data: { url: 'wss://api.derivws.com/trading/v1/options/ws/real?otp=test' } }) }) });
  const connected = new Promise(resolve => client.once('connected', resolve)); await client.connect(); await connected;
  await assert.rejects(client.request({ buy: 'test', price: 1 }), error => error.apiError && error.code === 'Denied'); client.close();
});
test('Demo client preserves PAT-to-REST-OTP flow but accepts only the OTP-bound Demo WebSocket', async () => {
  class FakeSocket extends EventEmitter { constructor(url) { super(); this.url = url; queueMicrotask(() => this.emit('open')); } close() { this.emit('close'); } }
  let endpoint, headers, sockets = 0;
  const client = new DerivClient({ mode: 'demo', appId: 'app', pat: 'server-secret', accountId: 'demo12345' }, {
    WebSocket: class extends FakeSocket { constructor(url) { sockets++; super(url); } },
    fetch: async (url, options) => { endpoint = url; headers = options.headers; return { ok: true, json: async () => ({ data: { url: 'wss://api.derivws.com/trading/v1/options/ws/demo?otp=once' } }) }; }
  });
  const connected = new Promise(resolve => client.once('connected', resolve)); await client.connect(); await connected;
  assert.equal(endpoint, 'https://api.derivws.com/trading/v1/options/accounts/demo12345/otp');
  assert.equal(headers.Authorization, 'Bearer server-secret'); assert.equal(headers['Deriv-App-ID'], 'app');
  assert.equal(client.mode, 'demo'); assert.equal(client.authenticated, true); assert.equal(client.demoAuthenticated, true); assert.equal(client.realAuthenticated, false); assert.equal(sockets, 1);
  client.close();
});
test('Demo client rejects a Real OTP URL before opening any WebSocket', async () => {
  let sockets = 0;
  class FakeSocket extends EventEmitter { constructor() { super(); sockets++; } }
  const client = new DerivClient({ mode: 'demo', appId: 'app', pat: 'fake-token', accountId: 'demo12345' }, {
    WebSocket: FakeSocket, fetch: async () => ({ ok: true, json: async () => ({ data: { url: 'wss://api.derivws.com/trading/v1/options/ws/real?otp=wrong-mode' } }) })
  });
  const warning = new Promise(resolve => client.once('warning', resolve)); await client.connect(); await warning;
  assert.equal(sockets, 0); assert.equal(client.connected, false); assert.equal(client.demoAuthenticated, false); client.close();
});
test('startup keeps existing Real environment unchanged and requires separate Demo config', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scdp-env-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const base = { DERIV_APP_ID: 'app-real', DERIV_PAT: 'fake-real-token', DERIV_ACCOUNT_ID: 'real12345', ADMIN_TOKEN: 'local-test-admin-token-long-enough', STATE_FILE: path.join(dir, 'real.json') };
  const realOnly = createEngines(base); t.after(() => Object.values(realOnly.clients).forEach(client => client.close()));
  assert.deepEqual(Object.keys(realOnly.engines), ['real']); assert.equal(realOnly.clients.real.mode, 'real');
  const dual = createEngines({ ...base, DERIV_DEMO_ACCOUNT_ID: 'demo12345', STATE_FILE_DEMO: path.join(dir, 'demo.json') });
  t.after(() => Object.values(dual.clients).forEach(client => client.close()));
  assert.deepEqual(Object.keys(dual.engines), ['real', 'demo']);
  assert.equal(dual.clients.demo.config.pat, 'fake-real-token'); assert.equal(dual.clients.demo.config.appId, 'app-real');
  assert.notEqual(dual.engines.demo.stateFile, dual.engines.real.stateFile);
  assert.throws(() => createEngines({ ...base, DERIV_DEMO_PAT: 'fake-demo-token' }), /DERIV_DEMO_ACCOUNT_ID is required/);
  assert.throws(() => createEngines({ ...base, DERIV_DEMO_ACCOUNT_ID: 'real12345', STATE_FILE_DEMO: path.join(dir, 'demo2.json') }), /must be different/);
  assert.throws(() => createEngines({ ...base, DERIV_DEMO_ACCOUNT_ID: 'demo12345', STATE_FILE_DEMO: base.STATE_FILE }), /different paths/);
});
test('Demo and Real engines keep confirmation and durable journals mode-separated', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scdp-modes-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  class DemoClient extends FakeClient { constructor() { super(); this.mode = 'demo'; this.authenticated = true; this.demoAuthenticated = true; this.realAuthenticated = false; } }
  const realClient = new FakeClient(), realFile = path.join(dir, 'real.json'), demoFile = path.join(dir, 'demo.json');
  const real = new ExecutionEngine({ client: realClient, strategy: fakeStrategy(), stateFile: realFile, accountId: 'real12345', mode: 'real' }); real.ready = true; real.candles = [candle(), candle()];
  const demoClient = new DemoClient(), demo = new ExecutionEngine({ client: demoClient, strategy: fakeStrategy(), stateFile: demoFile, accountId: 'demo12345', mode: 'demo' }); demo.ready = true; demo.candles = [candle(), candle()];
  const challenge = demo.issueConfirmation();
  assert.equal(challenge.mode, 'demo'); assert.match(challenge.confirmation, /DEMO TRADING WITH VIRTUAL FUNDS/);
  assert.equal(real.issueConfirmation().mode, 'real'); assert.match(real.confirmation.challenge.confirmation, /REAL MONEY TRADING/);
  await demo.start(challenge); assert.equal(demo.enabled, true); assert.equal(real.enabled, false);
  real.persist(); demo.persist();
  assert.equal(JSON.parse(fs.readFileSync(realFile)).mode, 'real'); assert.equal(JSON.parse(fs.readFileSync(demoFile)).mode, 'demo');
  assert.throws(() => new ExecutionEngine({ client: new DemoClient(), strategy: fakeStrategy(), stateFile: realFile, accountId: 'real12345', mode: 'demo' }), /version\/account\/mode mismatch/);
  assert.equal(demo.status().demoAuthenticated, true); assert.equal(demo.status().realAuthenticated, false);
});
test('HTTP controls are protected; health does not expose secrets', async t => {
  const { engine } = fixture(); const token = 'test-admin-token-long-enough';
  const server = createApp(engine, token).listen(0, '127.0.0.1'); t.after(() => server.close());
  await new Promise(resolve => server.once('listening', resolve)); const url = `http://127.0.0.1:${server.address().port}`;
  const health = await (await fetch(url)).json(); assert.equal(health.status, 'available'); assert.equal(health.connected, undefined); assert.equal(JSON.stringify(health).includes(token), false);
  const preflight = await fetch(url + '/status', { method: 'OPTIONS', headers: { Origin: 'null', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' } });
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('access-control-allow-origin'), 'null');
  assert.equal((await fetch(url+'/start', { method: 'POST' })).status, 401);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  assert.equal((await fetch(url+'/confirmation')).status, 401);
  assert.equal((await fetch(url+'/start', { method: 'POST', headers })).status, 409);
  const confirmation = await (await fetch(url+'/confirmation', { headers })).json();
  assert.equal((await fetch(url+'/start', { method: 'POST', headers, body: JSON.stringify(confirmation) })).status, 200); assert.equal(engine.enabled, true);
  assert.equal((await fetch(url+'/stop', { method: 'POST', headers })).status, 200); assert.equal(engine.enabled, false);
});
test('server exposes only configured account modes and routes state/control independently', async t => {
  const { engine: real } = fixture(); real.enabled = true;
  const demo = { mode: 'demo', confirmation: { accountId: 'demo12345' }, client: { connected: false, closed: false, async connect() {} },
    ready: false, enabled: false, status() { return { mode: 'demo', connected: this.client.connected, ready: this.ready, tradingEnabled: this.enabled }; },
    settings() { return { mode: 'demo' }; }, stop() { this.enabled = false; }, history() { return []; } };
  const token = 'mode-test-admin-token-long-enough', server = createApp({ real, demo }, token).listen(0, '127.0.0.1'); t.after(() => server.close());
  await new Promise(resolve => server.once('listening', resolve)); const url = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: `Bearer ${token}` };
  const modes = await (await fetch(url + '/modes', { headers })).json(); assert.deepEqual(modes.modes.map(x => x.mode), ['real', 'demo']);
  assert.equal((await (await fetch(url + '/status', { headers })).json()).mode, 'real');
  assert.equal((await (await fetch(url + '/status?mode=demo', { headers })).json()).mode, 'demo');
  assert.equal((await fetch(url + '/stop?mode=demo', { method: 'POST', headers })).status, 200);
  assert.equal(demo.enabled, false); assert.equal(real.enabled, true);
  const realOnly = createApp(real, token).listen(0, '127.0.0.1'); t.after(() => realOnly.close());
  await new Promise(resolve => realOnly.once('listening', resolve));
  assert.equal((await fetch(`http://127.0.0.1:${realOnly.address().port}/status?mode=demo`, { headers })).status, 404);
});

test('monitoring APIs are protected and validate bounded history queries', async t => {
  const { engine } = fixture(); engine.tradeHistory = [{ profit: 1, status: 'won' }];
  const token = 'test-admin-token-long-enough';
  const server = createApp(engine, token).listen(0, '127.0.0.1'); t.after(() => server.close());
  await new Promise(resolve => server.once('listening', resolve)); const url = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(url+'/pnl')).status, 401);
  const headers = { Authorization: `Bearer ${token}` };
  const pnl = await (await fetch(url+'/pnl', { headers })).json(); assert.equal(pnl.sessionProfit, 0);
  const trades = await (await fetch(url+'/trades?limit=1', { headers })).json(); assert.equal(trades.count, 1);
  assert.equal((await fetch(url+'/history?limit=0', { headers })).status, 400);
  assert.equal((await fetch(url+'/connect', { method: 'POST', headers })).status, 200);
});

test('unsupported original duration fails preflight without buying', async () => {
  const { engine, client } = fixture();
  client.handler = async () => { const e = new Error('Duration not supported for this market'); e.apiError = true; throw e; };
  await assert.rejects(start(engine), /Duration not supported/);
  assert.equal(engine.enabled, false); assert.equal(client.requests.some(x => x.buy), false);
});
test('durable storage failure latches trading off', async () => {
  const { engine, client } = fixture(); await start(engine);
  engine.stateFile = '/dev/null/cannot-create/state.json';
  await assert.rejects(engine.onMarket());
  assert.equal(engine.enabled, false); assert.equal(engine.storageFault, true);
  await assert.rejects(start(engine), /storage fault/);
  assert.equal(client.requests.some(x => x.buy), false);
});
test('old initialization cannot mark a disconnected session ready', async () => {
  const { engine, client } = fixture(); let resolve;
  client.handler = () => new Promise(r => { resolve = r; });
  const init = engine.initialize(); client.connected = false; client.emit('disconnected');
  resolve({ balance: { currency: 'USD' } });
  await assert.rejects(init, /Connection changed/); assert.equal(engine.ready, false);
});
test('reconciliation verifies known trade without resubmitting buy', async () => {
  const { engine, client, strategy } = fixture();
  engine.pending = { phase: 'uncertain', direction: 'CALL', stake: 1, submittedAt: new Date().toISOString() };
  client.handler = async p => ({ proposal_open_contract: { contract_id: p.contract_id, underlying: 'frxEURUSD',
    contract_type: 'CALL', buy_price: '1', purchase_time: Math.floor(Date.now()/1000), is_sold: 1, profit: '.75', status: 'won' } });
  await engine.reconcile(456);
  assert.equal(engine.pending, null); assert.equal(strategy.profit, .75);
  assert.equal(client.requests.some(x => x.buy), false);
});

test('original default strategy on forex-scale candles produces the expected PUT buy', async () => {
  const { Strategy } = require('../strategy');
  const client = new FakeClient(), strategy = new Strategy();
  const engine = new ExecutionEngine({ client, strategy, accountId: 'real-test' });
  engine.ready = true;
  const current = Math.floor(Date.now()/60000)*60;
  engine.candles = Array.from({length:124},(_,i)=>{
    const close=1.08+Math.sin(i*.12)*.005+Math.sin(i*.03)*.01;
    return {epoch:current-(123-i)*60,open:close,high:close+.0002,low:close-.0002,close};
  });
  await start(engine); await engine.onMarket();
  const proposals = client.requests.filter(p=>p.proposal);
  assert.equal(proposals.at(-1).contract_type, 'PUT');
  assert.equal(proposals.at(-1).underlying_symbol, 'frxEURUSD');
  assert.equal(proposals.at(-1).duration, 1); assert.equal(proposals.at(-1).amount, 1);
  assert.equal(client.requests.filter(p=>p.buy).length, 1);
  assert.equal(engine.pending.contractId,123);
});

test('startup and bare start never enable real execution', async () => {
  const { engine, client } = fixture();
  assert.equal(engine.enabled, false);
  await assert.rejects(engine.start(), /fresh authenticated/);
  assert.equal(client.requests.length, 0);
});
test('exact confirmation rejects altered stake, risk, account, phrase, and extra fields', async () => {
  for (const mutate of [x => { x.nextStake = 2; }, x => { x.riskLimits.maxLoss = 100; }, x => { x.riskLimits.maxMartingaleSteps = 10; },
    x => { x.accountId = 'other'; }, x => { x.confirmation = 'yes'; }, x => { x.extra = true; },
    x => { delete x.riskLimits; }]) {
    const { engine, client } = fixture(); const body = engine.issueConfirmation(); mutate(body);
    await assert.rejects(engine.start(body), /fresh authenticated/);
    assert.equal(engine.enabled, false); assert.equal(client.requests.length, 0);
  }
});
test('confirmation expiry, replay, stop, disconnect and state changes invalidate approval', async () => {
  const { engine, client, strategy } = fixture();
  let body = engine.issueConfirmation(); engine.confirmation.challenge.expiresAt = new Date(0).toISOString();
  await assert.rejects(engine.start(body), /fresh authenticated/);
  body = engine.issueConfirmation(); await engine.start(body); engine.stop();
  await assert.rejects(engine.start(body), /fresh authenticated/);
  body = engine.issueConfirmation(); client.emit('disconnected');
  await assert.rejects(engine.start(body), /fresh authenticated/);
  engine.ready = true; body = engine.issueConfirmation(); strategy.count++;
  await assert.rejects(engine.start(body), /fresh authenticated/);
  assert.equal(engine.enabled, false);
});
test('reconnection restores data but never consent or execution', async () => {
  const { engine, client } = fixture(); await start(engine);
  client.emit('disconnected'); await engine.initialize();
  assert.equal(engine.ready, true); assert.equal(engine.enabled, false);
  assert.equal(engine.confirmation.challenge, null);
  await assert.rejects(engine.start(), /fresh authenticated/);
  assert.equal(client.requests.some(x => x.buy), false);
});
test('runtime risk mutation and transport warning stop before a purchase', async () => {
  const first = fixture(); await start(first.engine);
  first.strategy.config.maxLoss = 100; await first.engine.onMarket();
  assert.equal(first.engine.enabled, false); assert.equal(first.client.requests.some(x => x.buy), false);
  const second = fixture(); await start(second.engine); second.client.emit('warning', 'transport failed');
  await second.engine.onMarket(); assert.equal(second.engine.enabled, false);
  assert.equal(second.client.requests.some(x => x.buy), false);
});
test('demo OTP URL never opens any socket and uses correct authenticated REST request', async () => {
  let sockets = 0, request;
  const client = new DerivClient({ appId: 'test-app', pat: 'fake-pat', accountId: 'chosen-real' }, {
    WebSocket: class { constructor() { sockets++; } },
    fetch: async (url, options) => { request = { url, options }; return { ok: true,
      json: async () => ({ data: { url: 'wss://api.derivws.com/trading/v1/options/ws/demo?otp=fake' } }) }; }
  });
  await client.connect(); client.close();
  assert.equal(sockets, 0); assert.equal(client.realAuthenticated, false);
  assert.equal(request.url, 'https://api.derivws.com/trading/v1/options/accounts/chosen-real/otp');
  assert.equal(request.options.method, 'POST'); assert.equal(request.options.redirect, 'error');
  assert.equal(request.options.headers.Authorization, 'Bearer fake-pat');
  assert.equal(request.options.headers['Deriv-App-ID'], 'test-app');
});
test('old demo journal is rejected, real journal restart preserves limits and stays stopped', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scdp-real-state-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'state.json'); const first = fixture(file);
  first.strategy.settled(-1); first.engine.persist();
  const restored = fixture(file); assert.equal(restored.strategy.profit, -1);
  assert.equal(restored.strategy.count, 1); assert.equal(restored.engine.enabled, false);
  assert.equal(restored.engine.confirmation.challenge, null);
  const saved = JSON.parse(fs.readFileSync(file)); saved.version = 1; delete saved.mode;
  fs.writeFileSync(file, JSON.stringify(saved)); assert.throws(() => fixture(file), /mismatch/);
});


test('market catalog and saved settings require authenticated server-side options validation', async t => {
  const { Strategy } = require('../strategy');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scdp-settings-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stateFile = path.join(dir, 'state.json');
  const client = new FakeClient();
  client.handler = async p => {
    if (p.active_symbols) return { active_symbols: [
      { symbol: 'frxEURUSD', display_name: 'EUR/USD', market: 'forex' },
      { symbol: 'R_10', display_name: 'Volatility 10 Index', market: 'synthetic_index' },
      { symbol: 'R_100', display_name: 'Volatility 100 Index', market: 'synthetic_index' },
      { symbol: 'R_25', display_name: 'Suspended index', is_trading_suspended: true }
    ] };
    if (p.contracts_for) return { contracts_for: { available: p.contracts_for === 'R_100'
      ? [{ contract_type: 'CALL' }]
      : [{ contract_type: 'CALL' }, { contract_type: 'PUT' }] } };
    if (p.balance) return { balance: { currency: 'USD' } };
    if (p.ticks_history) return { candles: [candle()] };
    if (p.ticks) return { tick: { symbol: p.ticks, pip_size: 5 } };
    if (p.proposal) return { proposal: { id: 'settings-preflight', ask_price: '1' } };
    return {};
  };
  const strategy = new Strategy();
  const engine = new ExecutionEngine({ client, strategy, stateFile, accountId: 'real-test' }); engine.ready = true;
  const token = 'test-admin-token-long-enough';
  const server = createApp(engine, token).listen(0, '127.0.0.1'); t.after(() => server.close());
  await new Promise(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(url + '/markets')).status, 401);
  assert.equal((await fetch(url + '/settings', { method: 'POST' })).status, 401);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const markets = await (await fetch(url + '/markets', { headers })).json();
  assert.deepEqual(markets.markets.map(m => m.symbol).sort(), ['R_10', 'frxEURUSD']);
  const requested = { symbol: 'R_100', granularity: 120, duration: 5, durationUnit: 's', baseStake: 1, useMartingale: true,
    martingaleFactor: 2, maxMartingaleSteps: 3, maxStake: 4, maxLoss: 10, takeProfit: 5, maxTrades: 20, maxConsecutiveLosses: 3,
    emaPeriod: 34, rsiPeriod: 10, rsiLevel: 48, crossWindow: 2, useAdxFilter: true, adxPeriod: 12, adxMin: 18,
    atrPeriod: 10, atrStopMult: 1.5, atrTargetMult: 0.75, noRepeatDirection: true };
  const rejected = await fetch(url + '/settings', { method: 'POST', headers, body: JSON.stringify(requested) });
  assert.equal(rejected.status, 409);
  assert.equal(strategy.config.symbol, 'frxEURUSD');
  requested.symbol = 'R_10';
  const savedResponse = await fetch(url + '/settings', { method: 'POST', headers, body: JSON.stringify(requested) });
  assert.equal(savedResponse.status, 200);
  const saved = await savedResponse.json();
  assert.equal(saved.settings.symbol, 'R_10'); assert.equal(saved.settings.granularity, 120); assert.equal(saved.settings.duration, 5); assert.equal(saved.settings.durationUnit, 's');
  assert.equal(saved.settings.emaPeriod, 34); assert.equal(saved.settings.noRepeatDirection, true);
  assert.equal(saved.settings.useMartingale, true); assert.equal(saved.settings.maxMartingaleSteps, 3); assert.equal(engine.enabled, false); assert.equal(engine.ready, true);
  const journal = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(journal.version, 3); assert.equal(journal.settings.symbol, 'R_10'); assert.equal(journal.settings.granularity, 120); assert.equal(journal.settings.emaPeriod, 34); assert.equal(journal.settings.useMartingale, true); assert.equal(journal.settings.maxMartingaleSteps, 3);
  const restored = new ExecutionEngine({ client: new FakeClient(), strategy: new Strategy(), stateFile, accountId: 'real-test' });
  assert.equal(restored.enabled, false); assert.equal(restored.pending, null);
  assert.equal(restored.strategy.config.symbol, 'R_10'); assert.equal(restored.strategy.config.granularity, 120); assert.equal(restored.strategy.config.duration, 5);
  assert.equal(restored.strategy.config.durationUnit, 's'); assert.equal(restored.strategy.config.emaPeriod, 34); assert.equal(restored.strategy.config.noRepeatDirection, true); assert.equal(restored.strategy.config.useMartingale, true); assert.equal(restored.strategy.config.maxMartingaleSteps, 3);
  restored.ready = true;
  const confirmation = restored.issueConfirmation();
  assert.equal(confirmation.symbol, 'R_10'); assert.equal(confirmation.duration, 5); assert.equal(confirmation.durationUnit, 's');
  assert.equal(confirmation.riskLimits.useMartingale, true);
  assert.equal(confirmation.riskLimits.maxMartingaleSteps, 3);
  assert.equal(confirmation.analysisSettings.emaPeriod, 34); assert.deepEqual(confirmation.analysisSettings.macd, { fast: 12, slow: 26, signal: 9 });
  restored.enabled = true;
  await assert.rejects(restored.updateSettings(requested), /stopped, idle/);
  restored.stop();
  restored.pending = { phase: 'uncertain' };
  await assert.rejects(restored.updateSettings(requested), /open or unresolved/);
});


test('current Deriv market schema normalizes renamed fields and reports contract validation failures', async () => {
  const { Strategy } = require('../strategy');
  const client = new FakeClient();
  client.handler = async p => {
    if (p.active_symbols) return { active_symbols: [
      { underlying_symbol: 'frxEURUSD', underlying_symbol_name: 'EUR/USD', market: 'forex' },
      { underlying_symbol: 'R_10', underlying_symbol_name: 'Volatility 10', market: 'synthetic_index' }
    ] };
    if (p.contracts_for === 'frxEURUSD') return { contracts_for: { available: [{ contract_type: 'CALL' }, { contract_type: 'PUT' }] } };
    if (p.contracts_for === 'R_10') { const e = new Error('API RateLimit: too many requests'); e.code = 'RateLimit'; throw e; }
    return {};
  };
  const engine = new ExecutionEngine({ client, strategy: new Strategy(), accountId: 'real-test' });
  engine.ready = true;
  const markets = await engine.markets();
  assert.deepEqual(markets.map(m => m.symbol), ['frxEURUSD']);
  assert.equal(markets[0].displayName, 'EUR/USD');
  assert.deepEqual(engine.marketDiagnostics, { activeSymbolCount: 2, candidateCount: 2, verifiedCount: 1, unsupportedCount: 0, failedCount: 1,
    sampleFailures: [{ symbol: 'R_10', code: 'RateLimit', message: 'API RateLimit: too many requests' }] });
  assert.deepEqual(client.requests[0], { active_symbols: 'brief', contract_type: ['CALL', 'PUT'] });
});

test('v4.1 durable settings migrate with current strategy defaults while preserving prior risk settings', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scdp-v41-settings-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'state.json');
  const { engine } = fixture(file); engine.persist();
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const key of ['granularity','emaPeriod','rsiPeriod','rsiLevel','crossWindow','useAdxFilter','adxPeriod','adxMin','atrPeriod','atrStopMult','atrTargetMult','noRepeatDirection','maxMartingaleSteps']) delete saved.settings[key];
  saved.settings.symbol = 'frxEURUSD'; saved.settings.maxLoss = 25;
  fs.writeFileSync(file, JSON.stringify(saved));
  const restored = fixture(file).engine;
  assert.equal(restored.strategy.config.maxLoss, 25);
  assert.equal(restored.strategy.config.granularity, 60);
  assert.equal(restored.strategy.config.emaPeriod, 50);
  assert.equal(restored.strategy.config.adxPeriod, 14);
  assert.equal(restored.strategy.config.noRepeatDirection, false);
  assert.equal(restored.strategy.config.maxMartingaleSteps, 3);
  assert.equal(restored.enabled, false);
});


test('market HTTP error exposes Deriv code and safe log detail without credentials', async t => {
  const { engine, client } = fixture();
  client.handler = async p => { if (p.active_symbols) { const e = new Error('Deriv authorization rejected'); e.code = 'InvalidToken'; throw e; } return {}; };
  const token = 'test-admin-token-long-enough';
  const server = createApp(engine, token).listen(0, '127.0.0.1');
  const originalWarn = console.warn; let log = '';
  console.warn = (...args) => { log += args.join(' '); };
  t.after(() => { console.warn = originalWarn; server.close(); });
  await new Promise(resolve => server.once('listening', resolve));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/markets`, { headers: { Authorization: `Bearer ${token}` } });
  const body = await response.json();
  assert.equal(response.status, 409); assert.equal(body.code, 'InvalidToken'); assert.equal(body.error, 'Deriv authorization rejected');
  assert.match(log, /\[markets\].*InvalidToken/); assert.equal(log.includes(token), false);
});

test('live confirmation binds every restored analysis parameter', () => {
  const { Strategy } = require('../strategy');
  const { LiveConfirmation } = require('../live-confirmation');
  const strategy = new Strategy(); const confirmation = new LiveConfirmation('real-test');
  const body = confirmation.issue(strategy);
  assert.deepEqual(body.analysisSettings, { granularity: 60, emaPeriod: 50, rsiPeriod: 14, rsiLevel: 50, crossWindow: 1,
    useAdxFilter: true, adxPeriod: 14, adxMin: 20, atrPeriod: 14, atrStopMult: 2, atrTargetMult: 0.5,
    noRepeatDirection: false, macd: { fast: 12, slow: 26, signal: 9 }, closedCandleOnly: true });
  const changed = structuredClone(body); changed.analysisSettings.adxMin = 25;
  assert.throws(() => confirmation.consume(changed, strategy), /exact account, market, analysis/);
});

test('settings validation rejects malformed durations and unbounded martingale inputs', () => {
  const { normalizeSettings } = require('../runtime-settings');
  const { DEFAULTS } = require('../strategy');
  assert.throws(() => normalizeSettings({ duration: 0 }, DEFAULTS), /Duration/);
  assert.throws(() => normalizeSettings({ granularity: 75 }, DEFAULTS), /timeframe/);
  assert.throws(() => normalizeSettings({ emaPeriod: 1 }, DEFAULTS), /emaPeriod/);
  assert.throws(() => normalizeSettings({ useAdxFilter: 'yes' }, DEFAULTS), /useAdxFilter/);
  assert.throws(() => normalizeSettings({ durationUnit: 'M' }, DEFAULTS), /Duration unit/);
  assert.throws(() => normalizeSettings({ martingaleFactor: 6 }, DEFAULTS), /martingaleFactor/);
  assert.throws(() => normalizeSettings({ maxMartingaleSteps: -1 }, DEFAULTS), /maxMartingaleSteps/);
  assert.throws(() => normalizeSettings({ maxMartingaleSteps: 11 }, DEFAULTS), /maxMartingaleSteps/);
  assert.throws(() => normalizeSettings({ maxMartingaleSteps: 1.5 }, DEFAULTS), /maxMartingaleSteps/);
  assert.throws(() => normalizeSettings({ useMartingale: 'true' }, DEFAULTS), /useMartingale/);
  assert.throws(() => normalizeSettings({ maxStake: 0.5 }, DEFAULTS), /maxStake/);
  assert.throws(() => normalizeSettings({ surprise: true }, DEFAULTS), /Unsupported settings field/);
});

test('Martingale progression is not silently clipped and stops above max stake or loss bounds', () => {
  const { Strategy } = require('../strategy');
  const { normalizeSettings } = require('../runtime-settings');
  const strategy = new Strategy();
  strategy.applySettings(normalizeSettings({ useMartingale: true, martingaleFactor: 2, maxStake: 4, maxLoss: 10 }, strategy.config));
  strategy.settled(-1); assert.equal(strategy.snapshot().stake, 2); assert.equal(strategy.canTrade(), true);
  strategy.settled(-1); assert.equal(strategy.snapshot().stake, 4); assert.equal(strategy.canTrade(), true);
  strategy.settled(-1); assert.equal(strategy.snapshot().stake, 8); assert.equal(strategy.canTrade(), false);
});

test('read-only market-data endpoint is protected and reports the real mode and open real position', async t => {
  const { engine, client } = fixture();
  const token = 'test-admin-token-long-enough';
  const server = createApp(engine, token).listen(0, '127.0.0.1'); t.after(() => server.close());
  await new Promise(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}/market-data`;
  assert.equal((await fetch(url)).status, 401);
  const headers = { Authorization: `Bearer ${token}` };
  const snapshot = await (await fetch(url, { headers })).json();
  assert.equal(snapshot.mode, 'real'); assert.equal(snapshot.accountMode, 'real');
  assert.equal(snapshot.symbol, 'frxEURUSD'); assert.ok(Array.isArray(snapshot.candles));
  assert.equal(snapshot.simulation.interpretation, 'directional_accuracy_not_profitability');
  assert.equal(snapshot.openPosition, null);
  assert.equal((await fetch(url + '?granularity=75', { headers })).status, 409);
  engine.pending = { phase: 'open', contractId: 789, direction: 'CALL', stake: 1, symbol: 'frxEURUSD', currency: 'USD', submittedAt: new Date().toISOString() };
  engine.openContract = { buy_price: '1', bid_price: '1.12', profit: '.12', status: 'open', date_start: 123, date_expiry: 183 };
  const position = await (await fetch(url, { headers })).json();
  assert.equal(position.openPosition.contractId, 789); assert.equal(position.openPosition.direction, 'CALL');
  assert.equal(position.openPosition.profit, 0.12); assert.equal(position.openPosition.symbol, 'frxEURUSD');
  assert.equal(client.requests.some(p => p.buy || p.proposal), false, 'market data must never submit a purchase');
});

test('historical evaluation labels unsupported tick expiry and insufficient history without inventing a rate', () => {
  const config = { ...require('../strategy').DEFAULTS, duration: 1, durationUnit: 't', duration_unit: 't' };
  const ticks = historicalDirectionalEvaluation([], config);
  assert.equal(ticks.status, 'unsupported_duration'); assert.equal(ticks.winRatePercent, null);
  const unaligned = historicalDirectionalEvaluation([], { ...config, duration: 30, durationUnit: 's', duration_unit: 's', granularity: 60 });
  assert.equal(unaligned.status, 'unsupported_duration'); assert.match(unaligned.reason, /لا تتطابق تماماً/);
  const short = historicalDirectionalEvaluation([candle(), candle()], { ...config, durationUnit: 'm', duration_unit: 'm' });
  assert.equal(short.status, 'insufficient_data'); assert.equal(short.winRatePercent, null);
  assert.equal(short.interpretation, 'directional_accuracy_not_profitability');
});
