import { EventEmitter } from 'node:events';

export class ScBridgeClient extends EventEmitter {
  constructor({ url, token }) {
    super();
    this.url = url;
    this.token = token || null;
    this.ws = null;
    this.hello = null;
    this._pending = new Map();
    this._nextId = 1;
  }

  _rejectAllPending(err) {
    const error = err instanceof Error ? err : new Error(String(err || 'SC-Bridge error'));
    for (const [id, pending] of this._pending.entries()) {
      try {
        pending.reject(error);
      } catch (_e) {}
      this._pending.delete(id);
    }
  }

  _resetConnection(err) {
    // Ensure callers can reconnect by clearing ws, and never leave RPC promises hanging.
    this._rejectAllPending(err || new Error('SC-Bridge closed'));
    try {
      if (this.ws) this.ws.onopen = this.ws.onerror = this.ws.onmessage = this.ws.onclose = null;
    } catch (_e) {}
    this.ws = null;
  }

  async connect({ timeoutMs = 10_000 } = {}) {
    if (this.ws) throw new Error('Already connected');

    const ws = new WebSocket(this.url);
    this.ws = ws;

    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('SC-Bridge connect timeout')), timeoutMs);
      ws.onopen = () => {};
      ws.onerror = (evt) => {
        clearTimeout(timer);
        this._resetConnection(new Error(evt?.message || 'SC-Bridge socket error'));
        reject(new Error(evt?.message || 'SC-Bridge socket error'));
      };
      ws.onmessage = (evt) => {
        let msg;
        try {
          msg = JSON.parse(String(evt.data || ''));
        } catch (_e) {
          return;
        }
        this._handleMessage(msg);
        if (msg.type === 'hello') {
          this.hello = msg;
          if (msg.requiresAuth && this.token) {
            ws.send(JSON.stringify({ type: 'auth', token: this.token }));
          } else if (msg.requiresAuth && !this.token) {
            clearTimeout(timer);
            this._resetConnection(new Error('SC-Bridge requires auth but no token provided'));
            reject(new Error('SC-Bridge requires auth but no token provided'));
          } else {
            clearTimeout(timer);
            resolve();
          }
          return;
        }
        if (msg.type === 'auth_ok') {
          clearTimeout(timer);
          resolve();
          return;
        }
        if (msg.type === 'error' && msg.error === 'Unauthorized.') {
          clearTimeout(timer);
          this._resetConnection(new Error('SC-Bridge unauthorized'));
          reject(new Error('SC-Bridge unauthorized'));
        }
      };
      ws.onclose = () => {
        clearTimeout(timer);
        this._resetConnection(new Error('SC-Bridge closed before ready'));
        reject(new Error('SC-Bridge closed before ready'));
      };
    });

    await ready;

    // After ready, keep the client reconnectable and never leave pending RPCs hanging.
    ws.onclose = () => {
      this._resetConnection(new Error('SC-Bridge closed'));
      this.emit('close');
    };
    ws.onerror = (evt) => {
      // Keep the connection reset behavior consistent with onclose; callers will reconnect.
      this._resetConnection(new Error(evt?.message || 'SC-Bridge socket error'));
      this.emit('close');
    };
  }

  close() {
    if (!this.ws) return;
    try {
      this.ws.close();
    } catch (_e) {}
    this._resetConnection(new Error('SC-Bridge closed'));
  }

  _rpc(type, payload) {
    if (!this.ws) throw new Error('Not connected');
    const id = this._nextId++;
    const msg = { id, type, ...payload };
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      try {
        this.ws.send(JSON.stringify(msg));
      } catch (err) {
        // If the websocket died, fail fast. Otherwise callers can hang forever.
        this._pending.delete(id);
        this._resetConnection(err);
        reject(err);
      }
      // Rely on caller timeouts for now.
    });
  }

  _handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    const id = msg.id;
    if (id && this._pending.has(id)) {
      const pending = this._pending.get(id);
      this._pending.delete(id);
      pending.resolve(msg);
      return;
    }
    if (msg.type === 'sidechannel_message') {
      this.emit('sidechannel_message', msg);
      return;
    }
    this.emit('event', msg);
  }

  async join(channel, { invite = null, welcome = null } = {}) {
    return this._rpc('join', { channel, invite, welcome });
  }

  async addInviterKey(pubkey) {
    return this._rpc('inviter_add', { pubkey });
  }

  async leave(channel) {
    return this._rpc('leave', { channel });
  }

  async open(channel, { via = null, invite = null, welcome = null } = {}) {
    return this._rpc('open', { channel, via, invite, welcome });
  }

  async send(channel, message, { invite = null, welcome = null } = {}) {
    return this._rpc('send', { channel, message, invite, welcome });
  }

  async subscribe(channels) {
    const list = Array.isArray(channels) ? channels : [channels];
    return this._rpc('subscribe', { channels: list });
  }

  async stats() {
    return this._rpc('stats', {});
  }

  async info() {
    return this._rpc('info', {});
  }

  async priceGet() {
    return this._rpc('price_get', {});
  }
}
