'use strict';

const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const credentials = require('./credentials.json');
const { descriptor } = require('./device');

class CloudError extends Error {
  constructor(message, status = 0, code = 'CLOUD_ERROR') {
    super(message);
    this.name = 'CloudError';
    this.status = status;
    this.code = code;
  }
}
class AuthenticationError extends CloudError {
  constructor(locked = false) {
    super(locked ? 'Whirlpool account is locked. Unlock it in the manufacturer app, then restart this plugin.' :
      'Whirlpool login failed. Check the email, password, brand, and region, then restart this plugin.',
    locked ? 423 : 401, locked ? 'ACCOUNT_LOCKED' : 'INVALID_AUTH');
    this.name = 'AuthenticationError';
  }
}

function parseOwned(data, accountId) {
  const locations = data?.[String(accountId)];
  if (!locations || typeof locations !== 'object' || Array.isArray(locations)) throw new CloudError('Invalid owned-appliance list.');
  const all = [];
  for (const appliances of Object.values(locations)) {
    if (!Array.isArray(appliances)) throw new CloudError('Invalid owned-appliance list.');
    for (const appliance of appliances) all.push(descriptor(appliance, false));
  }
  return all;
}

function parseShared(data) {
  if (!Array.isArray(data?.sharedAppliances)) throw new CloudError('Invalid shared-appliance list.');
  const all = [];
  for (const location of data.sharedAppliances) {
    if (!Array.isArray(location?.appliances)) throw new CloudError('Invalid shared-appliance list.');
    for (const appliance of location.appliances) all.push(descriptor(appliance, true));
  }
  return all;
}

class WhirlpoolClient extends EventEmitter {
  constructor(config, log, options = {}) {
    super();
    this.config = config;
    this.log = log;
    this.fetch = options.fetch || globalThis.fetch;
    this.cachePath = options.cachePath;
    this.baseUrl = config.region === 'US' ? 'https://api.whrcloud.com' : 'https://prod-api.whrcloud.eu';
    this.clients = credentials[config.brand];
    this.tokens = null;
    this.authPromise = null;
    this.halted = null;
    this.closed = false;
    this.controllers = new Set();
    this.refreshes = new Map();
    this.cacheWrites = Promise.resolve();
  }

  async loadSession() {
    if (!this.cachePath) return;
    try {
      const data = JSON.parse(await fs.readFile(this.cachePath, 'utf8'));
      if (typeof data.access_token === 'string' && typeof data.refresh_token === 'string' &&
        typeof data.expiresAt === 'number' && this.clients.some((c) => c.client_id === data.clientId)) {
        this.tokens = data;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') this.log.debug('Saved Whirlpool session could not be loaded; signing in again.');
    }
  }

  async saveSession() {
    if (!this.cachePath || !this.tokens) return;
    const data = JSON.stringify(this.tokens);
    this.cacheWrites = this.cacheWrites.catch(() => {}).then(async () => {
      const temp = `${this.cachePath}.${randomUUID()}.tmp`;
      try {
        await fs.mkdir(path.dirname(this.cachePath), { recursive: true, mode: 0o700 });
        await fs.writeFile(temp, data, { mode: 0o600, flag: 'wx' });
        await fs.rename(temp, this.cachePath);
      } catch {
        this.log.warn('Whirlpool session could not be saved. Login will be repeated after a restart.');
      } finally {
        await fs.unlink(temp).catch(() => {});
      }
    });
    await this.cacheWrites;
  }

  async rawRequest(endpoint, options = {}) {
    if (this.closed) throw new CloudError('Whirlpool client is stopped.');
    const controller = new AbortController();
    this.controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeout * 1000);
    timeout.unref?.();
    try {
      const response = await this.fetch(this.baseUrl + endpoint, {
        method: options.method || 'GET', headers: options.headers, body: options.body,
        signal: controller.signal, redirect: 'error',
      });
      // Consume the body under the same timeout as the request. Never include it in errors/logs.
      const text = await response.text();
      if (text.length > 2 * 1024 * 1024) throw new CloudError('Whirlpool response is too large.');
      let data = null;
      let validJson = true;
      if (text.trim()) {
        try { data = JSON.parse(text); } catch { validJson = false; }
      }
      return { status: response.status, data, validJson };
    } catch (error) {
      if (error instanceof CloudError) throw error;
      throw new CloudError(controller.signal.aborted ? 'Whirlpool request timed out or was stopped.' : 'Cannot reach the Whirlpool cloud.');
    } finally {
      clearTimeout(timeout);
      this.controllers.delete(controller);
    }
  }

  async ensureToken(force = false, rejectedToken) {
    if (this.halted) throw this.halted;
    if (this.authPromise) return this.authPromise;
    if (force && rejectedToken && this.tokens?.access_token !== rejectedToken) return;
    if (!force && this.tokens?.access_token && this.tokens.expiresAt > Date.now() + 60000) return;
    this.authPromise = this.authenticate().catch((error) => {
      if (error instanceof AuthenticationError) {
        this.halted = error;
        this.emit('authFailed', error);
      }
      throw error;
    }).finally(() => { this.authPromise = null; });
    return this.authPromise;
  }

  async authenticate() {
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'okhttp/3.12.0' };
    const attempts = [];
    const cachedClient = this.clients.find((c) => c.client_id === this.tokens?.clientId);
    if (this.tokens?.refresh_token && cachedClient) {
      attempts.push({ ...cachedClient, grant_type: 'refresh_token', refresh_token: this.tokens.refresh_token });
    }
    for (const client of this.clients) attempts.push({
      ...client, grant_type: 'password', username: this.config.username, password: this.config.password,
    });
    for (const body of attempts) {
      const response = await this.rawRequest('/oauth/token', { method: 'POST', headers, body: new URLSearchParams(body).toString() });
      if (response.status === 423) throw new AuthenticationError(true);
      if ([400, 401, 403].includes(response.status)) continue;
      if (response.status !== 200) throw new CloudError(`Whirlpool login service returned HTTP ${response.status}.`, response.status);
      const data = response.data;
      const seconds = Number(data?.expires_in);
      if (!response.validJson || typeof data?.access_token !== 'string' || !data.access_token || !Number.isFinite(seconds) || seconds <= 0) {
        throw new CloudError('Whirlpool returned an invalid login response.');
      }
      this.tokens = {
        access_token: data.access_token,
        refresh_token: typeof data.refresh_token === 'string' ? data.refresh_token :
          (body.grant_type === 'refresh_token' ? body.refresh_token : ''),
        expiresAt: Date.now() + seconds * 1000,
        accountId: data.accountId || (body.grant_type === 'refresh_token' ? this.tokens?.accountId : '') || '',
        clientId: body.client_id,
      };
      await this.saveSession();
      this.emit('authenticated');
      return;
    }
    throw new AuthenticationError();
  }

  async request(endpoint, options = {}) {
    await this.ensureToken();
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = this.tokens.access_token;
      const headers = {
        Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
        'User-Agent': 'okhttp/3.12.0', Pragma: 'no-cache', 'Cache-Control': 'no-cache',
        ...options.headers,
      };
      const result = await this.rawRequest(endpoint, {
        method: options.method || 'GET', headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
      if (result.status === 423) {
        const error = new AuthenticationError(true);
        this.halted = error;
        this.emit('authFailed', error);
        throw error;
      }
      if (result.status === 401 && attempt === 0) {
        await this.ensureToken(true, token);
        continue;
      }
      if (result.status === 401) {
        const error = new AuthenticationError();
        this.halted = error;
        this.emit('authFailed', error);
        throw error;
      }
      if (result.status < 200 || result.status >= 300) throw new CloudError(`Whirlpool cloud returned HTTP ${result.status}.`, result.status);
      if (!result.validJson && !options.allowText) throw new CloudError('Whirlpool returned invalid JSON.');
      return result.data;
    }
    throw new CloudError('Whirlpool request could not be authenticated.', 401);
  }

  async accountId() {
    await this.ensureToken();
    if (this.tokens.accountId) return String(this.tokens.accountId);
    const data = await this.request('/api/v1/getUserDetails');
    if (!['string', 'number'].includes(typeof data?.accountId) || !String(data.accountId)) throw new CloudError('Whirlpool did not return an account ID.');
    this.tokens.accountId = String(data.accountId);
    await this.saveSession();
    return this.tokens.accountId;
  }

  async discover() {
    const accountId = await this.accountId();
    const results = await Promise.allSettled([
      this.request(`/api/v2/appliance/all/account/${encodeURIComponent(accountId)}`).then((d) => parseOwned(d, accountId)),
      this.request('/api/v1/share-accounts/appliances', { headers: { 'WP-CLIENT-BRAND': this.config.brand } }).then(parseShared),
    ]);
    const [owned, shared] = results;
    for (const result of results) {
      if (result.status === 'rejected' && result.reason instanceof AuthenticationError) throw result.reason;
    }
    const ownedOk = owned.status === 'fulfilled';
    const sharedOk = shared.status === 'fulfilled';
    const sharedStatus = sharedOk ? (shared.value.length ? 'available' : 'empty') :
      shared.reason.status === 404 ? 'endpoint_unavailable' : 'error';
    if (!ownedOk && !(sharedOk && shared.value.length > 0)) {
      throw new CloudError('Appliance discovery failed. An empty shared list cannot replace a failed owned-appliance request.');
    }
    if (!ownedOk) this.log.warn('Owned-appliance discovery failed; existing accessories will be retained.');
    if (sharedStatus === 'endpoint_unavailable') {
      this.log.debug('Shared-appliance endpoint is unavailable (HTTP 404); owned discovery succeeded separately.');
    } else if (sharedStatus === 'error') {
      this.log.warn('Shared-appliance discovery failed; existing shared accessories will be retained.');
    }
    const merged = new Map();
    for (const info of [...(ownedOk ? owned.value : []), ...(sharedOk ? shared.value : [])]) {
      if (!merged.has(info.said)) merged.set(info.said, info);
    }
    const all = [...merged.values()];
    return { devices: all.filter((d) => d.kind !== 'unsupported'),
      unsupported: all.filter((d) => d.kind === 'unsupported'), ownedOk, sharedStatus };
  }

  refreshDevice(device) {
    if (this.refreshes.has(device.info.said)) return this.refreshes.get(device.info.said);
    const startedAt = Date.now();
    const request = this.request(`/api/v1/appliance/${encodeURIComponent(device.info.said)}`).then((data) => {
      if (!device.closed && !this.closed) device.applySnapshot(data, startedAt);
    }).catch((error) => {
      device.markUnavailable();
      throw error;
    }).finally(() => this.refreshes.delete(device.info.said));
    this.refreshes.set(device.info.said, request);
    return request;
  }

  async sendCommand(said, attributes) {
    const data = await this.request('/api/v1/appliance/command', {
      method: 'POST', allowText: true,
      body: { body: attributes, header: { said, command: 'setAttributes' } },
    });
    if (data && (data.success === false || (data.error && data.error !== '0') ||
      (data.errorCode !== undefined && ![0, '0', null].includes(data.errorCode)))) {
      throw new CloudError('Whirlpool rejected the appliance command.');
    }
  }

  async websocketUrl() {
    let data;
    try { data = await this.request('/api/v1/client_auth/webSocketUrl'); }
    catch (error) {
      // Preserve the classic SDK's documented EMEA fallback, without guessing
      // a different-region endpoint or bypassing an authentication failure.
      if (this.config.region === 'EU' && !(error instanceof AuthenticationError)) {
        this.log.debug('Using the classic EMEA event endpoint; URL discovery is unavailable.');
        return 'wss://ws.emeaprod.aws.whrcloud.com/appliance/websocket';
      }
      throw error;
    }
    try {
      const url = new URL(data?.url);
      if (url.protocol !== 'wss:' || url.username || url.password) throw new Error();
      return url.href;
    } catch {
      throw new CloudError('Whirlpool did not return a secure event-socket URL.');
    }
  }

  close() {
    this.closed = true;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
  }
}

module.exports = { WhirlpoolClient, CloudError, AuthenticationError, parseOwned, parseShared };
