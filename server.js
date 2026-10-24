'use strict';
const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const { DerivClient } = require('./deriv-client');
const { Strategy } = require('./strategy');
const { ExecutionEngine } = require('./execution');

function createApp(engineOrMap, adminToken) {
  if (typeof adminToken !== 'string' || adminToken.length < 24) throw new Error('ADMIN_TOKEN must contain at least 24 characters.');
  const engines = engineOrMap && typeof engineOrMap.status === 'function' ? { real: engineOrMap } : engineOrMap;
  if (!engines || !engines.real || typeof engines.real.status !== 'function' || Object.keys(engines).some(mode => !['real', 'demo'].includes(mode))) throw new Error('A Real engine and only supported account modes are required.');
  function selectEngine(req, res) {
    const mode = req.query.mode || req.body?.mode || 'real';
    if (!['real', 'demo'].includes(mode)) { res.status(400).json({ ok: false, error: 'mode must be real or demo.' }); return null; }
    const engine = engines[mode];
    if (!engine) { res.status(404).json({ ok: false, error: `${mode} account mode is not configured on this server.` }); return null; }
    if (engine.mode && engine.mode !== mode) { res.status(500).json({ ok: false, error: 'Configured engine/account mode mismatch.' }); return null; }
    return engine;
  }
  const app = express();
  app.disable('x-powered-by');
  // Android loads this packaged dashboard from file://, which sends Origin: null.
  // Allow only that opaque origin; every data/control endpoint still requires ADMIN_TOKEN.
  app.use((req, res, next) => {
    const origin = req.get('origin');
    if (origin === 'null') {
      res.vary('Origin');
      res.set('Access-Control-Allow-Origin', 'null');
      res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept');
      res.set('Access-Control-Max-Age', '600');
      if (req.method === 'OPTIONS') return res.sendStatus(204);
    }
    next();
  });
  app.use(express.json({ limit: '8kb' }));
  app.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  function requireAdmin(req, res, next) {
    const match = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
    const supplied = Buffer.from(match?.[1] || ''); const expected = Buffer.from(adminToken);
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return res.status(401).json({ ok: false, error: 'Unauthorized' });
    next();
  }
  app.get('/', (_req, res) => res.json({ ok: true, service: 'scdp-deriv-execution-bot', status: 'available' }));
  app.get('/modes', requireAdmin, (_req, res) => res.json({ ok: true, modes: Object.entries(engines).map(([mode, engine]) => ({
    mode, configured: true, accountId: engine.confirmation?.accountId || null,
    connected: engine.client.connected === true, ready: engine.ready === true, tradingEnabled: engine.enabled === true
  })) }));
  app.get('/status', requireAdmin, (req, res) => { const engine = selectEngine(req, res); if (engine) res.json({ ok: true, ...engine.status() }); });
  app.get('/settings', requireAdmin, (req, res) => { const engine = selectEngine(req, res); if (engine) res.json({ ok: true, ...engine.settings(), mode: engine.mode || req.query.mode || 'real' }); });
  app.get('/markets', requireAdmin, async (req, res) => {
    const engine = selectEngine(req, res); if (!engine) return;
    try { const markets = await engine.markets(); res.json({ ok: true, mode: engine.mode || req.query.mode || 'real', markets, diagnostics: engine.marketDiagnostics || null }); }
    catch (error) {
      const code = error.code || null;
      console.warn(`[markets${(engine.mode || 'real') === 'real' ? '' : ':demo'}] Deriv catalog request failed (${code || 'no-code'}): ${String(error.message || 'unknown error').slice(0, 240)}`);
      engine.marketDiagnostics = { activeSymbolCount: 0, candidateCount: 0, verifiedCount: 0, unsupportedCount: 0, failedCount: 1, sampleFailures: [], requestError: { code, message: String(error.message || 'unknown error').slice(0, 240) } };
      res.status(409).json({ ok: false, code, error: error.message });
    }
  });
  app.get('/market-data', requireAdmin, async (req, res) => {
    const engine = selectEngine(req, res); if (!engine) return;
    const symbol = req.query.symbol || engine.strategy.config.symbol;
    const granularity = req.query.granularity === undefined ? engine.strategy.config.granularity : Number(req.query.granularity);
    if (typeof symbol !== 'string' || !/^[A-Za-z0-9_]{2,40}$/.test(symbol) || !Number.isInteger(granularity)) return res.status(400).json({ ok: false, error: 'A valid symbol and integer granularity are required.' });
    try { res.json({ ok: true, ...await engine.marketData(symbol, granularity) }); }
    catch (error) { res.status(409).json({ ok: false, error: error.message }); }
  });
  app.post('/settings', requireAdmin, async (req, res) => {
    const engine = selectEngine(req, res); if (!engine) return;
    const { mode: _mode, ...patch } = req.body || {};
    try { res.json({ ok: true, mode: engine.mode || req.query.mode || 'real', settings: await engine.updateSettings(patch) }); }
    catch (error) { res.status(409).json({ ok: false, error: error.message, tradingEnabled: engine.enabled, settings: engine.settings() }); }
  });
  app.get('/trades', requireAdmin, (req, res) => {
    const engine = selectEngine(req, res); if (!engine) return;
    const rawLimit = req.query.limit === undefined ? 50 : Number(req.query.limit);
    if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 200) return res.status(400).json({ ok: false, error: 'limit must be an integer from 1 to 200.' });
    res.json({ ok: true, mode: engine.mode || req.query.mode || 'real', count: engine.history(rawLimit).length, trades: engine.history(rawLimit) });
  });
  app.get('/history', requireAdmin, (req, res) => {
    const engine = selectEngine(req, res); if (!engine) return;
    const rawLimit = req.query.limit === undefined ? 50 : Number(req.query.limit);
    if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 200) return res.status(400).json({ ok: false, error: 'limit must be an integer from 1 to 200.' });
    res.json({ ok: true, mode: engine.mode || req.query.mode || 'real', pnl: engine.strategy.snapshot().sessionProfit, trades: engine.history(rawLimit) });
  });
  app.get('/pnl', requireAdmin, (req, res) => {
    const engine = selectEngine(req, res); if (!engine) return;
    const snapshot = engine.strategy.snapshot();
    res.json({ ok: true, mode: engine.mode || req.query.mode || 'real', currency: snapshot.currency, sessionProfit: snapshot.sessionProfit,
      tradesCount: snapshot.tradesCount, lossStreak: snapshot.lossStreak, lastProfit: snapshot.lastProfit,
      tradingEnabled: engine.enabled, pending: engine.pending });
  });
  app.post('/connect', requireAdmin, async (req, res) => {
    const engine = selectEngine(req, res); if (!engine) return;
    if (engine.client.closed) return res.status(409).json({ ok: false, error: 'Deriv client is closed; restart the service before reconnecting.' });
    try {
      await engine.client.connect();
      res.json({ ok: true, ...engine.status(), note: `${engine.mode === 'real' ? 'Real-funds' : 'Demo virtual-funds'} connection was requested explicitly; trading remains disabled until its matching /confirmation and /start.` });
    } catch (error) { res.status(409).json({ ok: false, error: error.message }); }
  });
  app.post('/disconnect', requireAdmin, (req, res) => {
    const engine = selectEngine(req, res); if (!engine) return;
    engine.stop('Disconnected by operator'); engine.client.close();
    res.json({ ok: true, mode: engine.mode || req.query.mode || 'real', connected: false, tradingEnabled: false });
  });
  app.get('/confirmation', requireAdmin, (req, res) => {
    const engine = selectEngine(req, res); if (!engine) return;
    try { res.json(engine.issueConfirmation()); }
    catch (error) { res.status(409).json({ ok: false, error: error.message }); }
  });
  app.post('/start', requireAdmin, async (req, res) => {
    const engine = selectEngine(req, res); if (!engine) return;
    try {
      const status = await engine.start(req.body);
      res.json({ ok: true, ...status, note: engine.mode === 'real'
        ? 'REAL-MONEY execution enabled only after exact real-account confirmation; original strategy conditions are unchanged.'
        : 'DEMO execution with virtual funds enabled only after exact Demo-account confirmation; no real funds are used by this Demo engine.' });
    } catch (error) { res.status(409).json({ ok: false, mode: engine.mode || req.query.mode || 'real', tradingEnabled: engine.enabled, error: error.message }); }
  });
  app.post('/stop', requireAdmin, (req, res) => {
    const engine = selectEngine(req, res); if (!engine) return;
    engine.stop(); res.json({ ok: true, mode: engine.mode || req.query.mode || 'real', tradingEnabled: false,
      note: 'No new purchases will be submitted in this account mode. A buy already submitted cannot be cancelled; open contracts remain monitored until settlement.' });
  });
  app.post('/reconcile', requireAdmin, async (req, res) => {
    const engine = selectEngine(req, res); if (!engine) return;
    try { res.json({ ok: true, ...await engine.reconcile(req.body?.contractId) }); }
    catch (error) { res.status(409).json({ ok: false, mode: engine.mode || req.query.mode || 'real', error: error.message }); }
  });
  app.use((error, _req, res, _next) => res.status(400).json({ ok: false, error: 'Invalid request body.' }));
  return app;
}
function createEngines(env = process.env) {
  const required = ['DERIV_APP_ID', 'DERIV_PAT', 'DERIV_ACCOUNT_ID', 'ADMIN_TOKEN', 'STATE_FILE'];
  const missing = required.filter(key => !env[key]);
  if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  if (env.ADMIN_TOKEN.length < 24) throw new Error('ADMIN_TOKEN must contain at least 24 characters.');
  if (env.DERIV_SYMBOL && !/^[A-Za-z0-9_]{2,40}$/.test(env.DERIV_SYMBOL)) throw new Error('DERIV_SYMBOL must be a valid Deriv market symbol.');
  const realStateFile = env.STATE_FILE;
  if (!path.isAbsolute(realStateFile)) throw new Error('STATE_FILE must be an absolute path on a persistent disk.');
  const realStrategy = new Strategy(env.DERIV_SYMBOL ? { symbol: env.DERIV_SYMBOL } : {});
  const realClient = new DerivClient({ appId: env.DERIV_APP_ID, pat: env.DERIV_PAT, accountId: env.DERIV_ACCOUNT_ID, mode: 'real' });
  const realEngine = new ExecutionEngine({ client: realClient, strategy: realStrategy, stateFile: realStateFile, accountId: env.DERIV_ACCOUNT_ID, mode: 'real' });
  const engines = { real: realEngine }, clients = { real: realClient };
  const demoRelated = ['DERIV_DEMO_ACCOUNT_ID', 'DERIV_DEMO_PAT', 'DERIV_DEMO_APP_ID', 'STATE_FILE_DEMO', 'DERIV_DEMO_SYMBOL', 'DERIV_DEMO_CURRENCY'].some(key => Boolean(env[key]));
  if (demoRelated && !env.DERIV_DEMO_ACCOUNT_ID) throw new Error('Demo configuration was partially supplied; DERIV_DEMO_ACCOUNT_ID is required.');
  if (env.DERIV_DEMO_ACCOUNT_ID) {
    const demoAccountId = env.DERIV_DEMO_ACCOUNT_ID;
    if (!/^[A-Za-z0-9]{5,32}$/.test(demoAccountId)) throw new Error('DERIV_DEMO_ACCOUNT_ID must be a valid account ID.');
    if (demoAccountId === env.DERIV_ACCOUNT_ID) throw new Error('Demo and Real account IDs must be different.');
    const demoStateFile = env.STATE_FILE_DEMO;
    if (!demoStateFile || !path.isAbsolute(demoStateFile)) throw new Error('STATE_FILE_DEMO must be a separate absolute path on persistent storage.');
    if (path.resolve(demoStateFile) === path.resolve(realStateFile)) throw new Error('Demo and Real journals must use different paths.');
    if (env.DERIV_DEMO_SYMBOL && !/^[A-Za-z0-9_]{2,40}$/.test(env.DERIV_DEMO_SYMBOL)) throw new Error('DERIV_DEMO_SYMBOL must be a valid Deriv market symbol.');
    if (env.DERIV_DEMO_CURRENCY && !/^[A-Z]{3,5}$/.test(env.DERIV_DEMO_CURRENCY)) throw new Error('DERIV_DEMO_CURRENCY must be an uppercase currency code.');
    const demoConfig = { appId: env.DERIV_DEMO_APP_ID || env.DERIV_APP_ID,
      pat: env.DERIV_DEMO_PAT || env.DERIV_PAT, accountId: demoAccountId, mode: 'demo' };
    const demoStrategy = new Strategy({ ...(env.DERIV_DEMO_SYMBOL ? { symbol: env.DERIV_DEMO_SYMBOL } : {}), ...(env.DERIV_DEMO_CURRENCY ? { currency: env.DERIV_DEMO_CURRENCY } : {}) });
    const demoClient = new DerivClient(demoConfig);
    const demoEngine = new ExecutionEngine({ client: demoClient, strategy: demoStrategy, stateFile: demoStateFile, accountId: demoAccountId, mode: 'demo' });
    engines.demo = demoEngine; clients.demo = demoClient;
  }
  return { engines, clients };
}
function main() {
  const { engines, clients } = createEngines();
  const realEngine = engines.real, realClient = clients.real;
  const app = createApp(engines, process.env.ADMIN_TOKEN);
  const server = app.listen(Number(process.env.PORT) || 3000, '0.0.0.0', () => {
    console.log(`SCDP ${Object.keys(engines).join('+').toUpperCase()} service listening. All Deriv connections are stopped until an authenticated per-mode POST /connect.`);
  });
  let closing = false;
  const shutdown = () => {
    if (closing) return; closing = true;
    for (const [mode, engine] of Object.entries(engines)) { engine.stop(`Service shutting down (${mode})`); clients[mode].close(); }
    server.close(() => process.exit(0)); setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
  return { app, server, engines, clients, engine: realEngine, client: realClient };
}
if (require.main === module) { try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
module.exports = { createApp, createEngines, main };
