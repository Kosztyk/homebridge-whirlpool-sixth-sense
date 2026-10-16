'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { WhirlpoolClient, AuthenticationError } = require('../lib/client');
const { WhirlpoolDevice, descriptor, AC } = require('../lib/device');
const { logger, config, rawInfo, acSnapshot, response, session } = require('./helpers');

test('classic login uses form encoding and tries the supported brand clients', async () => {
  const calls = [];
  const log = logger();
  const client = new WhirlpoolClient(config({ password: 'a&b+c=d' }), log, { fetch: async (url, options) => {
    calls.push({ url, options });
    return calls.length === 1 ? response({}, 401) : response({ access_token: 'private-access', refresh_token: 'private-refresh', expires_in: 3600, accountId: '123' });
  } });
  await Promise.all([client.ensureToken(), client.ensureToken(), client.ensureToken()]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://prod-api.whrcloud.eu/oauth/token');
  assert.equal(calls[0].options.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(new URLSearchParams(calls[0].options.body).get('password'), 'a&b+c=d');
  assert.equal(new URLSearchParams(calls[1].options.body).get('client_id'), 'whirlpool_android_v1');
  assert.equal(client.tokens.clientId, 'whirlpool_android_v1');
  assert(!JSON.stringify(log.messages).includes('private-access'));
  client.close();
});

test('expired token refreshes with its original client before password fallback', async () => {
  const grants = [];
  const client = session(new WhirlpoolClient(config(), logger(), { fetch: async (_url, options) => {
    grants.push(new URLSearchParams(options.body).get('grant_type'));
    return grants.length === 1 ? response({}, 400) : response({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 });
  } }));
  client.tokens.expiresAt = 0;
  await client.ensureToken();
  assert.deepEqual(grants, ['refresh_token', 'password']);
  assert.equal(client.tokens.access_token, 'new-access');
  client.close();
});

test('HTTP 423 stops automatic login attempts', async () => {
  let calls = 0;
  const client = new WhirlpoolClient(config(), logger(), { fetch: async () => { calls++; return response({}, 423); } });
  await assert.rejects(client.ensureToken(), (e) => e instanceof AuthenticationError && e.code === 'ACCOUNT_LOCKED');
  await assert.rejects(client.ensureToken(), /account is locked/);
  assert.equal(calls, 1);
  client.close();
});

test('REST 401 renews once and repeats the exact command with the new token', async () => {
  const calls = [];
  const client = session(new WhirlpoolClient(config({ region: 'US' }), logger(), { fetch: async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/oauth/token')) return response({ access_token: 'new-access', expires_in: 3600, accountId: '123' });
    if (calls.length === 1) return response({}, 401);
    return response({ success: true });
  } }));
  await client.sendCommand('SAID/with slash', { [AC.targetTemperature]: '230' });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, 'https://api.whrcloud.com/api/v1/appliance/command');
  assert.equal(calls[2].options.headers.Authorization, 'Bearer new-access');
  assert.equal(calls[0].options.body, calls[2].options.body);
  assert.deepEqual(JSON.parse(calls[2].options.body), { body: { Sys_OpSetTargetTemp: '230' }, header: { said: 'SAID/with slash', command: 'setAttributes' } });
  client.close();
});

test('a second REST 401 halts retries instead of repeatedly logging in', async () => {
  const client = session(new WhirlpoolClient(config(), logger(), { fetch: async (url) =>
    url.endsWith('/oauth/token') ? response({ access_token: 'new-access', expires_in: 3600 }) : response({}, 401) }));
  await assert.rejects(client.request('/api/v1/test'), AuthenticationError);
  assert(client.halted);
  client.close();
});

test('owned discovery survives optional shared 404 and sends WP-CLIENT-BRAND', async () => {
  let sharedHeader;
  const client = session(new WhirlpoolClient(config(), logger(), { fetch: async (url, options) => {
    if (url.includes('/share-accounts/')) { sharedHeader = options.headers['WP-CLIENT-BRAND']; return response({}, 404); }
    return response({ '123': { home: [rawInfo()] } });
  } }));
  const found = await client.discover();
  assert.equal(found.devices.length, 1);
  assert.equal(found.sharedStatus, 'endpoint_unavailable');
  assert.equal(sharedHeader, 'Whirlpool');
  client.close();
});

test('failed owned request is not rescued by an empty shared list', async () => {
  const client = session(new WhirlpoolClient(config(), logger(), { fetch: async (url) =>
    url.includes('/share-accounts/') ? response({ sharedAppliances: [] }) : response({}, 503) }));
  await assert.rejects(client.discover(), /empty shared list/);
  client.close();
});

test('nonempty shared discovery can recover a failed owned request', async () => {
  const client = session(new WhirlpoolClient(config(), logger(), { fetch: async (url) =>
    url.includes('/share-accounts/') ? response({ sharedAppliances: [{ appliances: [rawInfo('SHARED', 'Washer_v1')] }] }) : response({}, 503) }));
  const found = await client.discover();
  assert.equal(found.devices[0].kind, 'laundry');
  assert.equal(found.devices[0].shared, true);
  assert.equal(found.ownedOk, false);
  client.close();
});

test('malformed shared list is rejected atomically and duplicate owned identity wins', async () => {
  let malformed = true;
  const client = session(new WhirlpoolClient(config(), logger(), { fetch: async (url) => {
    if (!url.includes('/share-accounts/')) return response({ '123': { home: [rawInfo()] } });
    return response({ sharedAppliances: [{ appliances: malformed ? [rawInfo('PARTIAL'), {}] : [rawInfo()] }] });
  } }));
  const first = await client.discover();
  assert.equal(first.sharedStatus, 'error');
  assert.deepEqual(first.devices.map((d) => d.said), ['TEST-SAID']);
  malformed = false;
  const second = await client.discover();
  assert.equal(second.devices.length, 1);
  assert.equal(second.devices[0].shared, false);
  client.close();
});

test('missing accountId falls back to user details', async () => {
  const urls = [];
  const client = session(new WhirlpoolClient(config(), logger(), { fetch: async (url) => { urls.push(url); return response({ accountId: 987 }); } }));
  client.tokens.accountId = '';
  assert.equal(await client.accountId(), '987');
  assert.equal(urls[0], 'https://prod-api.whrcloud.eu/api/v1/getUserDetails');
  client.close();
});

test('sessions persist with restrictive permissions and without the account password', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'whirlpool-session-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const cachePath = path.join(dir, 'cache', 'account.json');
  const client = session(new WhirlpoolClient(config(), logger(), { cachePath }));
  await client.saveSession();
  assert.equal((await fs.stat(cachePath)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.dirname(cachePath))).mode & 0o777, 0o700);
  assert(!(await fs.readFile(cachePath, 'utf8')).includes('test-password'));
  const restored = new WhirlpoolClient(config(), logger(), { cachePath });
  await restored.loadSession();
  assert.equal(restored.tokens.access_token, 'test-access');
  client.close(); restored.close();
});

test('status refresh uses an encoded SAID and coalesces concurrent calls', async () => {
  let calls = 0;
  let usedUrl;
  const client = session(new WhirlpoolClient(config(), logger(), { fetch: async (url) => {
    calls++; usedUrl = url; return response(acSnapshot());
  } }));
  const device = new WhirlpoolDevice(descriptor(rawInfo('ONE/TWO')), client);
  await Promise.all([client.refreshDevice(device), client.refreshDevice(device)]);
  assert.equal(calls, 1);
  assert(usedUrl.endsWith('/ONE%2FTWO'));
  assert.equal(device.available, true);
  device.close(); client.close();
});

test('explicit command rejection leaves device state unchanged', async () => {
  const client = session(new WhirlpoolClient(config(), logger(), { fetch: async () => response({ success: false }) }));
  const device = new WhirlpoolDevice(descriptor(rawInfo()), client);
  device.applySnapshot(acSnapshot());
  await assert.rejects(device.command({ [AC.power]: '0' }), /rejected/);
  assert.equal(device.bool(AC.power), true);
  device.close(); client.close();
});

test('cloud response bodies and account credentials do not appear in HTTP errors', async () => {
  const log = logger();
  const client = session(new WhirlpoolClient(config(), log, { fetch: async () => response({ password: 'DO-NOT-LEAK', token: 'DO-NOT-LEAK' }, 500) }));
  await assert.rejects(client.request('/api/v1/test'), (e) => !e.message.includes('DO-NOT-LEAK') && e.status === 500);
  assert(!JSON.stringify(log.messages).includes('DO-NOT-LEAK'));
  client.close();
});

test('event URL discovery uses the classic EU fallback but never guesses a US endpoint', async () => {
  const eu = session(new WhirlpoolClient(config(), logger(), { fetch: async () => response({}, 404) }));
  assert.equal(await eu.websocketUrl(), 'wss://ws.emeaprod.aws.whrcloud.com/appliance/websocket');
  const us = session(new WhirlpoolClient(config({ region: 'US' }), logger(), { fetch: async () => response({}, 404) }));
  await assert.rejects(us.websocketUrl(), /HTTP 404/);
  eu.close(); us.close();
});

test('event URL discovery accepts secure cloud URLs and rejects plain WebSockets', async () => {
  let url = 'wss://cloud.example.invalid/events';
  const client = session(new WhirlpoolClient(config(), logger(), { fetch: async () => response({ url }) }));
  assert.equal(await client.websocketUrl(), url);
  url = 'ws://cloud.example.invalid/events';
  await assert.rejects(client.websocketUrl(), /secure event-socket/);
  client.close();
});
