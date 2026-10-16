'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
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
