'use strict';
const { EventEmitter } = require('node:events');
const WebSocket = require('ws');

function validateRealUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid authenticated WebSocket URL.'); }
  if (url.protocol !== 'wss:' || url.hostname !== 'api.derivws.com' ||
      url.pathname !== '/trading/v1/options/ws/real' || url.port || url.username || url.password || url.hash || url.searchParams.getAll('otp').length !== 1 || !url.searchParams.get('otp') || [...url.searchParams.keys()].some(key => key !== 'otp')) {
    throw new Error('Refusing a non-real WebSocket endpoint.');
  }
  return value;
}
class DerivClient extends EventEmitter {
  constructor(config, deps = {}) {
    super(); this.config = config; this.fetch = deps.fetch || fetch;
    this.WebSocket = deps.WebSocket || WebSocket; this.pending = new Map();
    this.sequence = 0; this.connected = false; this.realAuthenticated = false; this.closed = false; this.attempt = 0;
    this.requestTimeout = deps.requestTimeout || 15000;
  }
  async connect() {
    if (this.closed || this.connecting || this.connected) return;
    this.connecting = true;
    try {
      const response = await this.fetch(`https://api.derivws.com/trading/v1/options/accounts/${encodeURIComponent(this.config.accountId)}/otp`, {
        method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${this.config.pat}`, 'Deriv-App-ID': this.config.appId, Accept: 'application/json' },
        signal: AbortSignal.timeout(15000)
      });
      const body = await response.json();
      if (!response.ok) throw new Error(`Real-account authentication failed (HTTP ${response.status}).`);
      const url = validateRealUrl(body?.data?.url);
      if (this.closed) return;
      const ws = new this.WebSocket(url, { handshakeTimeout: 15000 }); this.socket = ws;
      ws.on('open', () => {
        if (this.closed || this.socket !== ws) return;
        this.connected = true; this.realAuthenticated = true; this.attempt = 0; this.lastReceived = Date.now();
        this.pingTimer = setInterval(() => {
          if (Date.now() - this.lastReceived > 90000) return ws.terminate();
          this.request({ ping: 1 }).catch(() => ws.terminate());
        }, 30000); this.pingTimer.unref?.(); this.emit('connected');
      });
      ws.on('message', raw => {
        if (this.socket !== ws) return;
        this.lastReceived = Date.now();
        let message; try { message = JSON.parse(raw.toString()); } catch { return; }
        const pending = this.pending.get(message.req_id);
        if (pending) {
          clearTimeout(pending.timer); this.pending.delete(message.req_id);
          if (message.error) {
            const error = new Error(message.error.message || 'Deriv rejected request.');
            error.apiError = true; error.code = message.error.code; pending.reject(error);
          } else pending.resolve(message);
        }
        this.emit('message', message);
      });
      ws.on('error', () => { this.realAuthenticated = false; this.emit('warning', 'Real-account WebSocket transport error.'); ws.terminate(); });
      ws.on('close', () => {
        if (this.socket !== ws) return;
        clearInterval(this.pingTimer); this.connected = false; this.realAuthenticated = false; this.socket = null;
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Real-account disconnected; request outcome may be unknown.')); }
        this.pending.clear(); this.emit('disconnected'); this.reconnect();
      });
    } catch (error) { this.emit('warning', 'Real-account authentication/connection failed; check account type, PAT, app ID and network.'); this.reconnect(); }
    finally { this.connecting = false; }
  }
  reconnect() {
    if (this.closed || this.reconnectTimer) return;
    const delay = Math.min(30000, 1000 * 2 ** Math.min(this.attempt++, 5));
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(); }, delay);
    this.reconnectTimer.unref?.();
  }
  request(payload) {
    if (this.closed || !this.connected || !this.socket) return Promise.reject(new Error('Real-account is disconnected.'));
    const req_id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(req_id); reject(new Error('Deriv request timed out; do not blindly retry a purchase.')); }, this.requestTimeout);
      this.pending.set(req_id, { resolve, reject, timer });
      try { this.socket.send(JSON.stringify({ ...payload, req_id })); }
      catch (error) { clearTimeout(timer); this.pending.delete(req_id); reject(error); }
    });
  }
  close() {
    this.closed = true; this.connected = false; this.realAuthenticated = false; clearTimeout(this.reconnectTimer); clearInterval(this.pingTimer);
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Service stopped.')); }
    this.pending.clear(); this.socket?.close(1000, 'Service stopped');
  }
}
module.exports = { DerivClient, validateRealUrl };
