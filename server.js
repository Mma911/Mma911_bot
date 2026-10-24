'use strict';
const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const { DerivClient } = require('./deriv-client');
const { Strategy } = require('./strategy');
const { ExecutionEngine } = require('./execution');

function createApp(engine, adminToken) {
  if (typeof adminToken !== 'string' || adminToken.length < 24) throw new Error('ADMIN_TOKEN must contain at least 24 characters.');
  const app = express();
  app.disable('x-powered-by');
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
  app.use(express.json({ limit: '4kb' }));
  app.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  function requireAdmin(req, res, next) {
    const match = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
    const supplied = Buffer.from(match?.[1] || ''); const expected = Buffer.from(adminToken);
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return res.status(401).json({ ok: false, error: 'Unauthorized' });
    next();
  }
  app.get('/', (_req, res) => res.json({ ok: true, service: 'scdp-deriv-execution-bot', status: 'available' }));
  app.get('/status', requireAdmin, (_req, res) => res.json({ ok: true, ...engine.status() }));
  app.get('/trades', requireAdmin, (req, res) => {
    const rawLimit = req.query.limit === undefined ? 50 : Number(req.query.limit);
    if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 200) return res.status(400).json({ ok: false, error: 'limit must be an integer from 1 to 200.' });
    res.json({ ok: true, count: engine.history(rawLimit).length, trades: engine.history(rawLimit) });
  });
  app.get('/history', requireAdmin, (req, res) => {
    const rawLimit = req.query.limit === undefined ? 50 : Number(req.query.limit);
    if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 200) return res.status(400).json({ ok: false, error: 'limit must be an integer from 1 to 200.' });
    res.json({ ok: true, pnl: engine.strategy.snapshot().sessionProfit, trades: engine.history(rawLimit) });
  });
  app.get('/pnl', requireAdmin, (_req, res) => {
    const snapshot = engine.strategy.snapshot();
    res.json({ ok: true, mode: 'real', currency: snapshot.currency, sessionProfit: snapshot.sessionProfit,
      tradesCount: snapshot.tradesCount, lossStreak: snapshot.lossStreak, lastProfit: snapshot.lastProfit,
      tradingEnabled: engine.enabled, pending: engine.pending });
  });
  app.post('/connect', requireAdmin, async (_req, res) => {
    if (engine.client.closed) return res.status(409).json({ ok: false, error: 'Deriv client is closed; restart the service before reconnecting.' });
    await engine.client.connect();
    res.json({ ok: true, ...engine.status(), note: 'Authenticated connection was requested explicitly; trading remains disabled until /confirmation and /start.' });
  });
  app.post('/disconnect', requireAdmin, (_req, res) => {
    engine.stop('Disconnected by operator');
    engine.client.close();
    res.json({ ok: true, connected: false, tradingEnabled: false });
  });
  app.get('/confirmation', requireAdmin, (_req, res) => {
    try { res.json(engine.issueConfirmation()); }
    catch (error) { res.status(409).json({ ok: false, error: error.message }); }
  });
  app.post('/start', requireAdmin, async (req, res) => {
    try { res.json({ ok: true, ...await engine.start(req.body), note: 'Execution enabled with explicitly confirmed stake and risk limits.' }); }
    catch (error) { res.status(409).json({ ok: false, tradingEnabled: engine.enabled, error: error.message }); }
  });
  app.post('/stop', requireAdmin, (_req, res) => {
    engine.stop(); res.json({ ok: true, tradingEnabled: false,
      note: 'No new purchases will be submitted.' });
  });
  app.post('/reconcile', requireAdmin, async (req, res) => {
    try { res.json({ ok: true, ...await engine.reconcile(req.body?.contractId) }); }
    catch (error) { res.status(409).json({ ok: false, error: error.message }); }
  });
  app.use((error, _req, res, _next) => res.status(400).json({ ok: false, error: 'Invalid request body.' }));
  return app;
}
function main() {
  const missing = ['DERIV_APP_ID', 'DERIV_PAT', 'DERIV_ACCOUNT_ID', 'ADMIN_TOKEN', 'STATE_FILE'].filter(key => !process.env[key]);
  if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  if (process.env.ADMIN_TOKEN.length < 24) throw new Error('ADMIN_TOKEN must contain at least 24 characters.');
  const strategy = new Strategy();
  if (process.env.DERIV_SYMBOL) {
    strategy.config.symbol = process.env.DERIV_SYMBOL.trim();
  }
  const client = new DerivClient({ appId: process.env.DERIV_APP_ID, pat: process.env.DERIV_PAT, accountId: process.env.DERIV_ACCOUNT_ID });
  const stateFile = process.env.STATE_FILE;
  if (!path.isAbsolute(stateFile)) throw new Error('STATE_FILE must be an absolute path on a persistent disk.');
  const engine = new ExecutionEngine({ client, strategy, stateFile, accountId: process.env.DERIV_ACCOUNT_ID });
  const app = createApp(engine, process.env.ADMIN_TOKEN);
  const server = app.listen(Number(process.env.PORT) || 3000, '0.0.0.0', () => {
    console.log(`SCDP service listening on symbol ${strategy.config.symbol}. Deriv connection is stopped until authenticated POST /connect.`);
  });
  let closing = false;
  const shutdown = () => {
    if (closing) return; closing = true; engine.stop('Service shutting down'); client.close();
    server.close(() => process.exit(0)); setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
  return { app, server, engine, client };
}
if (require.main === module) { try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
module.exports = { createApp, main };
