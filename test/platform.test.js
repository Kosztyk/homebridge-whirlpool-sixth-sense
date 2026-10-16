'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { WhirlpoolPlatform, PLUGIN_NAME, PLATFORM_NAME, parallelLimit } = require('../lib/platform');
const { WhirlpoolDevice, descriptor, AC } = require('../lib/device');
const { normalizeConfig } = require('../lib/config');
const { hap, logger, config, rawInfo, acSnapshot, api, TestAccessory } = require('./helpers');

function fixture(t, options = {}) {
  const bridge = api();
  const platform = new WhirlpoolPlatform(logger(), config(options), bridge);
  platform.client.refreshDevice = async (device) => device.applySnapshot(acSnapshot());
  platform.events.start = () => {};
  t.after(() => platform.shutdown());
  return { platform, bridge };
}

function result(devices = [], extra = {}) {
  return { devices, unsupported: [], ownedOk: true, sharedStatus: 'empty', ...extra };
}

function cached(platform, info) {
  const uuid = hap.uuid.generate(`${PLUGIN_NAME}:${platform.accountKey}:${info.said}`);
  const accessory = new TestAccessory(info.name, uuid);
  accessory.context = { accountKey: platform.accountKey, whirlpool: info };
  platform.configureAccessory(accessory);
  return accessory;
}

test('entry point registers the expected qualified plugin and platform aliases', () => {
  const calls = [];
  require('../index')({ registerPlatform: (...args) => calls.push(args) });
  assert.equal(calls[0][0], PLUGIN_NAME);
  assert.equal(calls[0][1], PLATFORM_NAME);
  assert.equal(calls[0][2], WhirlpoolPlatform);
});

test('discovery registers native accessories once and stores no authentication data in context', async (t) => {
  const { platform, bridge } = fixture(t);
  const info = descriptor(rawInfo());
  await platform.reconcile(result([info]));
  await platform.reconcile(result([info]));
  assert.equal(bridge.registered.length, 1);
  assert.equal(platform.devices.size, 1);
  assert(bridge.registered[0].getServiceById(hap.Service.HeaterCooler, 'climate'));
  const json = JSON.stringify(bridge.registered[0].context);
  assert(!json.includes('password'));
  assert(!json.includes('test@example'));
  assert(!json.includes('token'));
});

test('shared 404 retains cached shared appliances while owned discovery continues', async (t) => {
  const { platform, bridge } = fixture(t);
  const shared = descriptor(rawInfo('SHARED'), true);
  const accessory = cached(platform, shared);
  platform.restoreCachedDevices();
  await platform.reconcile(result([], { sharedStatus: 'endpoint_unavailable' }));
  assert(platform.accessories.has(accessory.UUID));
  assert.equal(bridge.unregistered.length, 0);
});

test('partial owned failure retains cached appliances but authoritative empty lists remove them', async (t) => {
  const { platform, bridge } = fixture(t);
  const info = descriptor(rawInfo('OLD'));
  const accessory = cached(platform, info);
  platform.restoreCachedDevices();
  await platform.reconcile(result([], { ownedOk: false, sharedStatus: 'available' }));
  assert(platform.accessories.has(accessory.UUID));
  await platform.reconcile(result());
  assert(!platform.accessories.has(accessory.UUID));
  assert.equal(bridge.unregistered.length, 1);
  assert.equal(platform.devices.size, 0);
});

test('explicit exclusions remove cached accessories before cloud discovery', (t) => {
  const { platform, bridge } = fixture(t, { devices: [{ said: 'EXCLUDED', exclude: true }] });
  cached(platform, descriptor(rawInfo('EXCLUDED')));
  platform.restoreCachedDevices();
  assert.equal(bridge.unregistered.length, 1);
  assert.equal(platform.accessories.size, 0);
});

test('excluded newly discovered appliances are never registered', async (t) => {
  const { platform, bridge } = fixture(t, { devices: [{ said: 'EXCLUDED', exclude: true }] });
  await platform.reconcile(result([descriptor(rawInfo('EXCLUDED'))]));
  assert.equal(platform.devices.size, 0);
  assert.equal(bridge.registered.length, 0);
});

test('device names and configured temperature limits reach native HomeKit services', async (t) => {
  const { platform, bridge } = fixture(t, { devices: [{ said: 'CUSTOM', name: 'Bedroom AC', minTemperature: 17, maxTemperature: 28 }] });
  await platform.reconcile(result([descriptor(rawInfo('CUSTOM'))]));
  const service = bridge.registered[0].getServiceById(hap.Service.HeaterCooler, 'climate');
  assert.equal(service.getCharacteristic(hap.Characteristic.ConfiguredName).value, 'Bedroom AC');
  assert.equal(service.getCharacteristic(hap.Characteristic.CoolingThresholdTemperature).props.minValue, 17);
  assert.equal(service.getCharacteristic(hap.Characteristic.CoolingThresholdTemperature).props.maxValue, 28);
});

test('shutdown during discovery prevents registrations and aborts clients', async (t) => {
  const { platform, bridge } = fixture(t);
  let finish;
  platform.client.discover = () => new Promise((resolve) => { finish = resolve; });
  const discovery = platform.discover();
  platform.shutdown();
  finish(result([descriptor(rawInfo())]));
  await discovery;
  assert.equal(bridge.registered.length, 0);
  assert.equal(platform.client.closed, true);
});

test('fresh cloud status recovers a cached offline accessory', async (t) => {
  const { platform } = fixture(t);
  const info = descriptor(rawInfo());
  const accessory = cached(platform, info);
  platform.restoreCachedDevices();
  const active = accessory.getServiceById(hap.Service.HeaterCooler, 'climate').getCharacteristic(hap.Characteristic.Active);
  await assert.rejects(active.handleGetRequest());
  await platform.reconcile(result([info]));
  assert.equal(await active.handleGetRequest(), 1);
});

test('concurrency limit bounds cloud requests and preserves failure ordering', async () => {
  let active = 0;
  let maxActive = 0;
  const results = await parallelLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setImmediate(resolve));
    active--;
    if (n === 4) throw new Error('test failure');
    return n;
  });
  assert.equal(maxActive, 3);
  assert.equal(results[3].status, 'rejected');
  assert.equal(results[6].value, 7);
});

test('configuration rejects unsafe intervals, malformed overrides, and ambiguous duplicate SAIDs', () => {
  assert.throws(() => normalizeConfig(config({ pollInterval: 1 })), /Poll interval/);
  assert.throws(() => normalizeConfig(config({ devices: [{ said: 'ONE', minTemperature: 30, maxTemperature: 20 }] })), /below/);
  assert.throws(() => normalizeConfig(config({ devices: [{ said: 'ONE' }, { said: 'ONE' }] })), /unique/);
  assert.throws(() => normalizeConfig(config({ enablePush: 'false' })), /true or false/);
  assert.equal(normalizeConfig(config({ brand: 'whirlpool', region: 'eu' })).region, 'EU');
});

test('blank optional device rows are skipped while valid overrides remain active', () => {
  const warnings = [];
  const normalized = normalizeConfig(config({ devices: [
    {}, { exclude: false, minTemperature: 16, maxTemperature: 30 },
    { said: '' }, { said: '   ', name: 'Unused row' }, null, 'invalid row',
    { said: ' CUSTOM ', name: ' Bedroom AC ', exclude: true, minTemperature: 17, maxTemperature: 28 },
  ] }), (message) => warnings.push(message));
  assert.equal(warnings.length, 6);
  assert(warnings.every((message) => message.includes('automatic discovery will continue')));
  assert.deepEqual(normalized.devices, [
    { said: 'CUSTOM', name: 'Bedroom AC', exclude: true, minTemperature: 17, maxTemperature: 28 },
  ]);
  assert.deepEqual(normalizeConfig(config({ devices: [{}] })).devices, []);
});

test('startup with an unused GUI row still authenticates, discovers, and registers an appliance', async (t) => {
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'whirlpool-startup-regression-'));
  const bridge = api(storage);
  const log = logger();
  const platform = new WhirlpoolPlatform(log, config({ devices: [
    { exclude: false, minTemperature: 16, maxTemperature: 30 },
    { said: 'TEST-SAID', name: 'Bedroom AC' },
  ] }), bridge);
  t.after(async () => {
    platform.shutdown();
    await fs.rm(storage, { recursive: true, force: true });
  });
  assert(platform.client);
  const urls = [];
  platform.client.fetch = async (url) => {
    urls.push(url);
    let data;
    if (url.endsWith('/oauth/token')) data = {
      access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 3600, accountId: '123',
    };
    else if (url.includes('/all/account/')) data = { '123': { home: [rawInfo()] } };
    else if (url.includes('/share-accounts/')) return new Response('{}', { status: 404 });
    else data = acSnapshot();
    return new Response(JSON.stringify(data), { status: 200 });
  };
  await platform.start();
  assert(urls.some((url) => url.endsWith('/oauth/token')));
  assert(urls.some((url) => url.includes('/all/account/')));
  assert.equal(bridge.registered.length, 1);
  assert.equal(bridge.registered[0].displayName, 'Bedroom AC');
  const sensor = bridge.registered[0].getServiceById(hap.Service.HeaterCooler, 'climate');
  assert.equal(await sensor.getCharacteristic(hap.Characteristic.CurrentTemperature).handleGetRequest(), 24.5);
  assert(log.messages.some(([level, message]) => level === 'warn' && message.includes('without a SAID')));
  assert(!log.messages.some(([level]) => level === 'error'));
});

test('settings schema accepts empty per-device rows and defaults the list to empty', () => {
  const Ajv = require('ajv');
  const schema = require('../config.schema.json');
  const ajv = new Ajv({ strict: false });
  ajv.addFormat('email', /^[^\s@]+@[^\s@]+\.[^\s@]+$/);
  const validate = ajv.compile(schema.schema);
  const example = { ...require('../config.example.json'), devices: [
    {}, { said: '' }, { exclude: false, minTemperature: 16, maxTemperature: 30 },
  ] };
  assert(validate(example), JSON.stringify(validate.errors));
  assert.deepEqual(schema.schema.properties.devices.default, []);
});

test('configuration form, package metadata, and entry-point aliases agree', () => {
  const Ajv = require('ajv');
  const schema = require('../config.schema.json');
  const pkg = require('../package.json');
  const ajv = new Ajv({ strict: false });
  ajv.addFormat('email', /^[^\s@]+@[^\s@]+\.[^\s@]+$/);
  const validate = ajv.compile(schema.schema);
  assert(validate(require('../config.example.json')), JSON.stringify(validate.errors));
  assert.equal(pkg.name, PLUGIN_NAME);
  assert.equal(schema.pluginAlias, PLATFORM_NAME);
  assert(pkg.keywords.includes('homebridge-plugin'));
  assert(pkg.keywords.includes('supports-homekit'));
  assert.equal(pkg.author.name, 'Kosztyk');
});
