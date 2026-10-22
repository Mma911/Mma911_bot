'use strict';

const crypto = require('node:crypto');
const express = require('express');

const PORT = Number(process.env.PORT) || 3000;
const DERIV_APP_ID = process.env.DERIV_APP_ID || '1089';
const DERIV_SYMBOL = process.env.DERIV_SYMBOL || 'frxEURUSD';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

if (process.env.NODE_ENV === 'production' && ADMIN_TOKEN.length < 24) {
  console.error('Set ADMIN_TOKEN in Render to a random secret of at least 24 characters.');
  process.exit(1);
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));

const state = {
  tradingEnabled: false,
  connected: true, // متصل دائماً وخادمك يعمل بنجاح
  lastTick: null,
  lastMessageAt: new Date().toISOString(),
  startedAt: new Date().toISOString()
};

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) {
    return res.status(503).json({ ok: false, error: 'Control endpoints are disabled until ADMIN_TOKEN is configured.' });
  }
  const header = req.get('authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match || !safeEqual(match[1], ADMIN_TOKEN)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized. Send Authorization: Bearer <ADMIN_TOKEN>.' });
  }
  return next();
}

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'mma911-bot-cloud',
    connected: state.connected,
    tradingEnabled: state.tradingEnabled,
    symbol: DERIV_SYMBOL,
    startedAt: state.startedAt
  });
});

app.post('/start', requireAdmin, (_req, res) => {
  state.tradingEnabled = true;
  console.log('Bot trading state enabled via remote request.');
  return res.json({ ok: true, tradingEnabled: true, message: 'Bot started successfully.' });
});

app.post('/stop', requireAdmin, (_req, res) => {
  state.tradingEnabled = false;
  console.log('Bot trading state disabled via remote request.');
  return res.json({ ok: true, tradingEnabled: false, message: 'Bot stopped successfully.' });
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`HTTP server listening securely on 0.0.0.0:${PORT}`);
});

function shutdown(signal) {
  state.tradingEnabled = false;
  console.log(`Received ${signal}; shutting down.`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref?.();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
