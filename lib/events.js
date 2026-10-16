'use strict';

const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const WebSocket = require('ws');

function frame(command, headers = {}) {
  const escape = (x) => String(x).replace(/\\/g, '\\\\').replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/:/g, '\\c');
  return `${command}\n${Object.entries(headers).map(([k, v]) => `${escape(k)}:${escape(v)}`).join('\n')}\n\n\0`;
}

class StompDecoder {
  constructor() { this.buffer = ''; }
  feed(chunk) {
    this.buffer += chunk.toString();
    if (Buffer.byteLength(this.buffer) > 1024 * 1024) {
      this.buffer = '';
      throw new Error('Event frame is too large.');
    }
    const frames = [];
    let end;
    while ((end = this.buffer.indexOf('\0')) >= 0) {
      const raw = this.buffer.slice(0, end).replace(/^[\r\n]+/, '');
      this.buffer = this.buffer.slice(end + 1);
      if (!raw) continue;
      const split = /\r?\n\r?\n/.exec(raw);
      if (!split) continue;
      const head = raw.slice(0, split.index).split(/\r?\n/);
      frames.push({ command: head[0], headers: head.slice(1).join('\n'), body: raw.slice(split.index + split[0].length) });
    }
    if (/^[\r\n]+$/.test(this.buffer)) this.buffer = '';
    return frames;
  }
}

class WhirlpoolEvents extends EventEmitter {
  constructor(client, log, options = {}) {
    super();
    this.client = client;
    this.log = log;
    this.WebSocket = options.WebSocket || WebSocket;
    this.running = false;
    this.connecting = false;
    this.socket = null;
    this.saids = new Set();
    this.subscriptions = new Map();
    this.retryDelay = 30000;
    this.connected = false;
  }

  start(saids) {
    this.setDevices(saids);
    if (this.running) return;
    this.running = true;
    void this.connect();
  }

  setDevices(saids) {
    this.saids = new Set(saids);
    if (this.connected) this.subscribe();
  }

  subscribe() {
    if (!this.connected || this.socket?.readyState !== this.WebSocket.OPEN) return;
    for (const [said, id] of this.subscriptions) {
      if (!this.saids.has(said)) {
        this.socket.send(frame('UNSUBSCRIBE', { id }));
        this.subscriptions.delete(said);
      }
    }
    for (const said of this.saids) {
      if (this.subscriptions.has(said)) continue;
      const id = randomUUID();
      this.socket.send(frame('SUBSCRIBE', { id, destination: `/topic/${said}`, ack: 'auto' }));
      this.subscriptions.set(said, id);
    }
  }

  async connect() {
    if (!this.running || this.connecting || this.socket || this.client.halted) return;
    this.connecting = true;
    try {
      await this.client.ensureToken();
      const url = await this.client.websocketUrl();
      if (!this.running || this.client.closed) return;
      const token = this.client.tokens.access_token;
      const ws = new this.WebSocket(url, { handshakeTimeout: this.client.config.requestTimeout * 1000, maxPayload: 1024 * 1024 });
      this.socket = ws;
      const decoder = new StompDecoder();
      let invalidToken = false;
      let lastPong = Date.now();
      ws.on('open', () => {
        if (!this.running) return ws.terminate();
        ws.send(frame('CONNECT', { 'accept-version': '1.1,1.2', 'heart-beat': '30000,0', wcloudtoken: token }));
        this.connectTimeout = setTimeout(() => {
          if (!this.connected) ws.terminate();
        }, this.client.config.requestTimeout * 1000);
        this.connectTimeout.unref?.();
        this.heartbeat = setInterval(() => {
          if (ws.readyState !== this.WebSocket.OPEN) return;
          if (Date.now() - lastPong > 90000) return ws.terminate();
          ws.ping();
          if (this.connected) ws.send('\n');
        }, 30000);
        this.heartbeat.unref?.();
      });
      ws.on('pong', () => { lastPong = Date.now(); });
      ws.on('message', (data) => {
        if (ws !== this.socket || !this.running) return;
        try {
          for (const msg of decoder.feed(data)) {
            if (msg.command === 'CONNECTED') {
              clearTimeout(this.connectTimeout);
              this.connected = true;
              this.retryDelay = 30000;
              this.subscribe();
              this.emit('connected');
            } else if (msg.command === 'ERROR') {
              invalidToken = /token invalid|invalid token|unauthorized/i.test(`${msg.headers}\n${msg.body}`);
              ws.close(1000);
            } else if (msg.command === 'MESSAGE') {
              let body;
              try { body = JSON.parse(msg.body); } catch { continue; }
              if (typeof body?.said === 'string' && this.saids.has(body.said) && body.attributeMap &&
                typeof body.attributeMap === 'object' && !Array.isArray(body.attributeMap)) {
                this.emit('attributes', body.said, body.attributeMap, body.timestamp);
              }
            }
          }
        } catch {
          this.log.debug('Ignoring a malformed Whirlpool event frame.');
          ws.terminate();
        }
      });
      ws.on('error', () => {
        this.log.debug('Whirlpool event socket is unavailable; scheduled polling continues.');
      });
      ws.on('close', (code) => {
        if (ws !== this.socket) return;
        this.socket = null;
        this.connected = false;
        this.subscriptions.clear();
        clearInterval(this.heartbeat);
        clearTimeout(this.connectTimeout);
        if (!this.running) return;
        this.emit('disconnected');
        if (invalidToken || code === 3000) {
          this.client.ensureToken(true, token).catch(() => {}).finally(() => this.schedule());
        } else this.schedule();
      });
    } catch {
      if (this.running && !this.client.halted) {
        this.log.debug('Whirlpool push connection failed; scheduled polling continues.');
        this.schedule();
      }
    } finally {
      this.connecting = false;
    }
  }

  schedule() {
    if (!this.running || this.client.halted || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, this.retryDelay);
    this.retryTimer.unref?.();
    this.retryDelay = Math.min(this.retryDelay * 2, 240000);
  }

  stop() {
    this.running = false;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    clearTimeout(this.connectTimeout);
    clearInterval(this.heartbeat);
    this.connected = false;
    this.subscriptions.clear();
    if (this.socket) {
      this.socket.terminate();
      this.socket = null;
    }
  }
}

module.exports = { WhirlpoolEvents, StompDecoder, frame };
