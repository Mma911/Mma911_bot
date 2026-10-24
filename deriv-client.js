'use strict';
const { EventEmitter } = require('node:events');
const WebSocket = require('ws');

function validateAccountUrl(value, mode) {
  if (!['real', 'demo'].includes(mode)) throw new Error('Unsupported Deriv account mode.');
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid authenticated WebSocket URL.'); }
  if (url.protocol !== 'wss:' || url.hostname !== 'api.derivws.com' ||
      url.pathname !== `/trading/v1/options/ws/${mode}` || url.port || url.username || url.password || url.hash || url.searchParams.getAll('otp').length !== 1 || !url.searchParams.get('otp') || [...url.searchParams.keys()].some(key => key !== 'otp')) {
    throw new Error(`Refusing a WebSocket endpoint that does not match the configured ${mode} account.`);
  }
  return value;
}
function validateRealUrl(value) { return validateAccountUrl(value, 'real'); }
function validateDemoUrl(value) { return validateAccountUrl(value, 'demo'); }
class DerivClient extends EventEmitter {
  constructor(config, deps = {}) {
    super();
    const mode = config.mode || 'real';
    if (!['real', 'demo'].includes(mode)) throw new Error('Deriv client mode must be real or demo.');
    this.mode = mode; this.config = { ...config, mode }; this.fetch = deps.fetch || fetch;
    this.WebSocket = deps.WebSocket || WebSocket; this.pending = new Map();
    this.sequence = 0; this.connected = false; this.authenticated = false; this.realAuthenticated = false; this.demoAuthenticated = false; this.closed = false; this.attempt = 0;
    this.requestTimeout = deps.requestTimeout || 15000;
  }
  setAuthenticated(value) {
    this.authenticated = value === true;
    this.realAuthenticated = this.mode === 'real' && this.authenticated;
    this.demoAuthenticated = this.mode === 'demo' && this.authenticated;
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
      if (!response.ok) throw new Error(`${this.mode === 'real' ? 'Real' : 'Demo'}-account authentication failed (HTTP ${response.status}).`);
      const url = validateAccountUrl(body?.data?.url, this.mode);
      if (this.closed) return;
      const ws = new this.WebSocket(url, { handshakeTimeout: 15000 }); this.socket = ws;
      ws.on('open', () => {
        if (this.closed || this.socket !== ws) return;
        this.connected = true; this.setAuthenticated(true); this.attempt = 0; this.lastReceived = Date.now();
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
      ws.on('error', () => { this.setAuthenticated(false); this.emit('warning', `${this.mode === 'real' ? 'Real' : 'Demo'}-account WebSocket transport error.`); ws.terminate(); });
      ws.on('close', () => {
        if (this.socket !== ws) return;
        clearInterval(this.pingTimer); this.connected = false; this.setAuthenticated(false); this.socket = null;
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(`${this.mode === 'real' ? 'Real' : 'Demo'}-account disconnected; request outcome may be unknown.`)); }
        this.pending.clear(); this.emit('disconnected'); this.reconnect();
      });
    } catch (error) { this.emit('warning', `${this.mode === 'real' ? 'Real' : 'Demo'}-account authentication/connection failed; check the account ID, PAT, app ID and network.`); this.reconnect(); }
    finally { this.connecting = false; }
  }
  reconnect() {
    if (this.closed || this.reconnectTimer) return;
    const delay = Math.min(30000, 1000 * 2 ** Math.min(this.attempt++, 5));
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(); }, delay);
    this.reconnectTimer.unref?.();
  }
  request(payload) {
    if (this.closed || !this.connected || !this.socket) return Promise.reject(new Error(`${this.mode === 'real' ? 'Real' : 'Demo'}-account is disconnected.`));
    const req_id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(req_id); reject(new Error('Deriv request timed out; do not blindly retry a purchase.')); }, this.requestTimeout);
      this.pending.set(req_id, { resolve, reject, timer });
      try { this.socket.send(JSON.stringify({ ...payload, req_id })); }
      catch (error) { clearTimeout(timer); this.pending.delete(req_id); reject(error); }
    });
  }
  close() {
    this.closed = true; this.connected = false; this.setAuthenticated(false); clearTimeout(this.reconnectTimer); clearInterval(this.pingTimer);
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Service stopped.')); }
    this.pending.clear(); this.socket?.close(1000, 'Service stopped');
  }
}
module.exports = { DerivClient, validateAccountUrl, validateRealUrl, validateDemoUrl };
