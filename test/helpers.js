'use strict';

const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const homebridgeRequire = createRequire(require.resolve('homebridge'));
const hap = homebridgeRequire('@homebridge/hap-nodejs');
const { AC, LAUNDRY } = require('../lib/device');

function logger() {
  const messages = [];
  return Object.fromEntries(['debug', 'info', 'warn', 'error'].map((level) => [level, (...args) => messages.push([level, ...args])]).concat([['messages', messages]]));
}

function config(extra = {}) {
  return { username: 'test@example.invalid', password: 'test-password', region: 'EU', brand: 'Whirlpool',
    requestTimeout: 5, pollInterval: 60, discoveryInterval: 900, enablePush: false,
    exposeExtraControls: true, devices: [], ...extra };
}

function rawInfo(said = 'TEST-SAID', model = 'AirConditioner_v1') {
  return { SAID: said, APPLIANCE_NAME: 'Living AC', DATA_MODEL_KEY: model, CATEGORY_NAME: 'Air Conditioner', MODEL_NO: 'TEST-MODEL', SERIAL: 'TEST-SERIAL' };
}

function acSnapshot(extra = {}) {
  return { attributes: Object.fromEntries(Object.entries({
    [AC.online]: '1', [AC.power]: '1', [AC.mode]: '1', [AC.modeSet]: '1',
    [AC.currentTemperature]: '245', [AC.targetTemperature]: '220', [AC.humidity]: '46',
    [AC.fan]: '4', [AC.swing]: '1', [AC.eco]: '0', [AC.quiet]: '0', [AC.turbo]: '1', [AC.display]: '4', ...extra,
  }).map(([k, v]) => [k, { value: v, updateTime: 1000 }])) };
}

function laundrySnapshot(extra = {}) {
  return { attributes: Object.fromEntries(Object.entries({
    [AC.online]: '1', [LAUNDRY.state]: '7', [LAUNDRY.door]: '0', [LAUNDRY.remaining]: '3600',
    [LAUNDRY.detergent]: '3', WashCavity_CycleStatusWashing: '1', ...extra,
  }).map(([k, v]) => [k, { value: v, updateTime: 1000 }])) };
}

function response(data, status = 200) {
  return new Response(data === undefined ? '' : JSON.stringify(data), { status });
}

function session(client) {
  client.tokens = { access_token: 'test-access', refresh_token: 'test-refresh', expiresAt: Date.now() + 3600000,
    accountId: '123', clientId: 'whirlpool_emea_android_v1' };
  return client;
}

class TestAccessory extends hap.Accessory {
  constructor(name, uuid, category) { super(name, uuid); this.context = {}; if (category !== undefined) this.category = category; }
}

function api(storagePath = '/tmp/whirlpool-test-unused') {
  const api = new EventEmitter();
  api.hap = hap;
  api.platformAccessory = TestAccessory;
  api.user = { storagePath: () => storagePath };
  api.registered = [];
  api.unregistered = [];
  api.updated = [];
  api.registerPlatformAccessories = (_plugin, _platform, items) => api.registered.push(...items);
  api.unregisterPlatformAccessories = (_plugin, _platform, items) => api.unregistered.push(...items);
  api.updatePlatformAccessories = (items) => api.updated.push(...items);
  return api;
}

module.exports = { hap, logger, config, rawInfo, acSnapshot, laundrySnapshot, response, session, TestAccessory, api };
