'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { WhirlpoolPlatform, PLUGIN_NAME, PLATFORM_NAME } = require('../lib/platform');
const { descriptor } = require('../lib/device');
const { logger, config, rawInfo, acSnapshot, laundrySnapshot } = require('./helpers');

async function realBridge(t, options = {}) {
  const homebridgeDir = path.dirname(require.resolve('homebridge'));
  const [{ HomebridgeAPI }, { BridgeService }] = await Promise.all([
    import(pathToFileURL(path.join(homebridgeDir, 'api.js')).href),
    import(pathToFileURL(path.join(homebridgeDir, 'bridgeService.js')).href),
  ]);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'whirlpool-real-cache-'));
  const api = new HomebridgeAPI();
  api.user = { storagePath: () => directory };
  const lifecycle = [];
  api.on('registerPlatformAccessories', () => lifecycle.push('register'));
  api.on('updatePlatformAccessories', () => lifecycle.push('update'));
  let platform;
  const plugin = { getActiveDynamicPlatform: () => platform, getPluginIdentifier: () => PLUGIN_NAME };
  const bridge = new BridgeService(api, { getPlugin: () => plugin }, {}, {
    cachedAccessoriesDir: path.join(directory, 'accessories'),
    cachedAccessoriesItemName: 'cachedAccessories', externalAccessoriesItemName: 'externalAccessories',
  }, { name: 'Whirlpool Test Bridge', hap: { enabled: true } });
  bridge.cachedAccessoriesFileLoaded = true;
  platform = new WhirlpoolPlatform(logger(), config(options), api);
  platform.client.refreshDevice = async (device) => device.applySnapshot(
    device.info.kind === 'aircon' ? acSnapshot() : laundrySnapshot());
  t.after(async () => {
    platform.shutdown();
    api.removeAllListeners();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { api, bridge, platform, lifecycle, directory };
}

function discovered(devices) {
  return { devices, unsupported: [], ownedOk: true, sharedStatus: 'empty' };
}

test('a discovered AC reaches the actual HAP bridge and disk cache before any cache updates', async (t) => {
  const f = await realBridge(t);
  await f.platform.reconcile(discovered([descriptor(rawInfo())]));
  assert.equal(f.lifecycle[0], 'register', 'A cache update must not introduce an unregistered accessory');
  assert.equal(f.bridge.bridge.bridgedAccessories.length, 1, 'The real bridge must advertise the discovered accessory');
  const saved = f.bridge.storageService.getItemSync('cachedAccessories');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].plugin, PLUGIN_NAME);
  assert.equal(saved[0].platform, PLATFORM_NAME);
  assert.equal(saved[0].category, f.api.hap.Categories.AIR_CONDITIONER);
  const climate = f.bridge.cachedPlatformAccessories[0].getServiceById(f.api.hap.Service.HeaterCooler, 'climate');
  assert.equal(climate.isPrimaryService, true);
  assert(climate.linkedServices.includes(f.bridge.cachedPlatformAccessories[0].getServiceById(f.api.hap.Service.Fanv2, 'fan')));
  assert(saved[0].services.some((service) => service.UUID === f.api.hap.Service.HeaterCooler.UUID));
});

test('rediscovery and new sensor services keep one bridged accessory and a serializable cache', async (t) => {
  const f = await realBridge(t);
  f.platform.client.refreshDevice = async (device) => {
    const data = acSnapshot();
    delete data.attributes.Sys_OpStatusDisplayHumidity;
    device.applySnapshot(data);
  };
  const info = descriptor(rawInfo());
  await f.platform.reconcile(discovered([info]));
  const device = f.platform.devices.get(info.said);
  device.applyAttributes({ Sys_OpStatusDisplayHumidity: '54' }, 2000);
  const saved = f.bridge.storageService.getItemSync('cachedAccessories');
  assert(saved[0].services.some((service) => service.UUID === f.api.hap.Service.HumiditySensor.UUID));
  await f.platform.reconcile(discovered([info]));
  assert.equal(f.lifecycle.filter((event) => event === 'register').length, 1);
  assert.equal(f.bridge.bridge.bridgedAccessories.length, 1);
  assert.equal(f.bridge.cachedPlatformAccessories.length, 1);
});

test('a disk-cached AC restores through Homebridge without duplicate registration', async (t) => {
  const first = await realBridge(t);
  const info = descriptor(rawInfo());
  await first.platform.reconcile(discovered([info]));
  const saved = first.bridge.storageService.getItemSync('cachedAccessories');
  first.platform.shutdown();

  const second = await realBridge(t);
  const legacyCache = JSON.parse(JSON.stringify(saved));
  legacyCache[0].category = second.api.hap.Categories.OTHER;
  second.bridge.cachedPlatformAccessories = legacyCache.map((entry) => second.api.platformAccessory.deserialize(entry));
  second.bridge.restoreCachedPlatformAccessories();
  second.platform.restoreCachedDevices();
  await second.platform.reconcile(discovered([info]));
  assert.equal(second.lifecycle.filter((event) => event === 'register').length, 0);
  assert.equal(second.bridge.bridge.bridgedAccessories.length, 1);
  const restored = second.bridge.cachedPlatformAccessories[0];
  assert.equal(restored.UUID, saved[0].UUID);
  assert.equal(restored.category, second.api.hap.Categories.AIR_CONDITIONER);
  assert.equal(await restored.getServiceById(second.api.hap.Service.HeaterCooler, 'climate')
    .getCharacteristic(second.api.hap.Characteristic.CurrentTemperature).handleGetRequest(), 24.5);
  assert.equal(second.bridge.storageService.getItemSync('cachedAccessories').length, 1);
  assert.equal(second.bridge.storageService.getItemSync('cachedAccessories')[0].category, second.api.hap.Categories.AIR_CONDITIONER);
});

test('mixed appliance discovery registers the batch before either accessory can enter the cache', async (t) => {
  const f = await realBridge(t);
  const ac = descriptor(rawInfo('AC'));
  const washer = descriptor({ ...rawInfo('WASHER', 'Washer_v1'), APPLIANCE_NAME: 'Washer' });
  await f.platform.reconcile(discovered([ac, washer]));
  assert.equal(f.lifecycle[0], 'register');
  assert.equal(f.bridge.bridge.bridgedAccessories.length, 2);
  const saved = f.bridge.storageService.getItemSync('cachedAccessories');
  assert.equal(saved.length, 2);
  assert(saved.every((entry) => entry.plugin === PLUGIN_NAME && entry.platform === PLATFORM_NAME));
});
