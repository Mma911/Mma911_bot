'use strict';

const crypto = require('node:crypto');
const express = require('express');
const WebSocket = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const DERIV_APP_ID = process.env.DERIV_APP_ID || '1089';
const DERIV_SYMBOL = process.env.DERIV_SYMBOL || 'frxEURUSD';
const DERIV_WS_URL = process.env.DERIV_WS_URL
  || `wss://ws.derivws.com/websockets/v3?app_id=${encodeURIComponent(DERIV_APP_ID)}`;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

if (process.env.NODE_ENV === 'production' && ADMIN_TOKEN.length < 24) {
  console.error('Set ADMIN_TOKEN in Railway to a random secret of at least 24 characters.');
  process.exit(1);
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));

const state = {
  tradingEnabled: false,
  connected: false,
  reconnectAttempt: 0,
  lastTick: null,
  lastMessageAt: null,
  startedAt: new Date().toISOString()
};

let derivSocket = null;
let reconnectTimer = null;
let pingTimer = null;
let shuttingDown = false;

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

function sendDeriv(payload) {
  if (!derivSocket || derivSocket.readyState !== WebSocket.OPEN) return false;
  derivSocket.send(JSON.stringify(payload));
  return true;
}

function onTick(tick) {
  state.lastTick = {
    symbol: tick.symbol || DERIV_SYMBOL,
    quote: Number(tick.quote),
    epoch: Number(tick.epoch)
  };
  state.lastMessageAt = new Date().toISOString();

  // Strategy/order execution is intentionally not implemented in this starter.
  // Add a tested strategy here before treating /start as actual automated trading.
  if (state.tradingEnabled) {
    console.log(`[tick] ${state.lastTick.symbol} ${state.lastTick.quote} (trading state enabled; no orders are placed by this starter)`);
  }
}

function scheduleReconnect() {
  if (shuttingDown || reconnectTimer) return;
  state.connected = false;
  // A lost connection fails closed: never resume trading automatically.
  state.tradingEnabled = false;

  const baseMs = 1000;
  const maxMs = 30000;
  const exponential = Math.min(maxMs, baseMs * (2 ** Math.min(state.reconnectAttempt, 5)));
  const delayMs = Math.round(exponential * (0.8 + Math.random() * 0.4));
  state.reconnectAttempt += 1;
  console.warn(`Deriv disconnected; reconnecting in ${delayMs} ms.`);

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectDeriv();
  }, delayMs);
  reconnectTimer.unref?.();
}

function connectDeriv() {
  if (shuttingDown) return;
  if (derivSocket && (derivSocket.readyState === WebSocket.OPEN || derivSocket.readyState === WebSocket.CONNECTING)) return;

  console.log(`Connecting to Deriv WebSocket for ${DERIV_SYMBOL}...`);
  let ws;
  try {
    ws = new WebSocket(DERIV_WS_URL, { handshakeTimeout: 15000 });
  } catch (error) {
    console.error('Could not create Deriv WebSocket:', error.message);
    scheduleReconnect();
    return;
  }

  derivSocket = ws;

  ws.on('open', () => {
    if (derivSocket !== ws) return;
    state.connected = true;
    state.reconnectAttempt = 0;
    console.log('Connected to Deriv public market-data WebSocket.');
    ws.send(JSON.stringify({ ticks: DERIV_SYMBOL, subscribe: 1, req_id: 1 }));
    clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ ping: 1 }));
    }, 30000);
    pingTimer.unref?.();
  });

  ws.on('message', (data) => {
    if (derivSocket !== ws) return;
    state.lastMessageAt = new Date().toISOString();
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      console.warn('Received an unparseable Deriv message.');
      return;
    }

    if (message.error) {
      console.error('Deriv API error:', message.error.message || 'Unknown API error');
      return;
    }
    if (message.msg_type === 'tick' && message.tick) onTick(message.tick);
  });

  ws.on('error', (error) => {
    console.error('Deriv WebSocket error:', error.message);
  });

  ws.on('close', (code) => {
    if (derivSocket === ws) derivSocket = null;
    clearInterval(pingTimer);
    pingTimer = null;
    state.connected = false;
    state.tradingEnabled = false;
    console.warn(`Deriv WebSocket closed (${code}).`);
    scheduleReconnect();
  });
}

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'scdp-deriv-railway-bot',
    connected: state.connected,
    tradingEnabled: state.tradingEnabled,
    symbol: DERIV_SYMBOL,
    lastTick: state.lastTick,
    lastMessageAt: state.lastMessageAt,
    startedAt: state.startedAt
  });
});

app.post('/start', requireAdmin, (_req, res) => {
  if (!state.connected) {
    return res.status(503).json({ ok: false, tradingEnabled: false, error: 'Deriv is not connected; trading was not enabled.' });
  }
  state.tradingEnabled = true;
  return res.json({ ok: true, tradingEnabled: true, note: 'Trading state enabled. This starter does not place orders; add a tested strategy first.' });
});

app.post('/stop', requireAdmin, (_req, res) => {
  state.tradingEnabled = false;
  return res.json({ ok: true, tradingEnabled: false, note: 'Trading state disabled. This endpoint does not close any Deriv contract.' });
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`HTTP server listening on 0.0.0.0:${PORT}`);
  connectDeriv();
});

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  state.tradingEnabled = false;
  console.log(`Received ${signal}; shutting down.`);
  clearTimeout(reconnectTimer);
  clearInterval(pingTimer);
  if (derivSocket) derivSocket.close(1000, 'Server shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref?.();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
