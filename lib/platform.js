'use strict';

const path = require('node:path');
const { createHash } = require('node:crypto');
const { normalizeConfig } = require('./config');
const { WhirlpoolClient, AuthenticationError } = require('./client');
const { WhirlpoolEvents } = require('./events');
const { WhirlpoolDevice } = require('./device');
const { WhirlpoolAccessory } = require('./accessory');

const PLUGIN_NAME = 'homebridge-whirlpool-sixth-sense';
const PLATFORM_NAME = 'WhirlpoolSixthSense';

async function parallelLimit(items, limit, operation) {
  let cursor = 0;
  const results = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      try { results[index] = { status: 'fulfilled', value: await operation(items[index]) }; }
      catch (reason) { results[index] = { status: 'rejected', reason }; }
    }
  }));
  return results;
}

class WhirlpoolPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.api = api;
    this.accessories = new Map();
    this.registeredAccessories = new Set();
    this.devices = new Map();
    this.controllers = new Map();
    this.stopped = false;
    this.started = false;
    this.polling = false;
    this.discovering = false;
    this.retryDelay = 30000;
    this.pollFailures = new Set();
    try { this.config = normalizeConfig(config, (message) => log.warn(message)); }
    catch (error) {
      log.error(`Whirlpool configuration: ${error.message}`);
      return;
    }
    if (this.config.debug) {
      this.log = {
        info: (...args) => log.info(...args), warn: (...args) => log.warn(...args), error: (...args) => log.error(...args),
        debug: (...args) => log.info('[debug]', ...args),
      };
    }
    this.accountKey = createHash('sha256').update(`${this.config.brand}:${this.config.region}:${this.config.username.toLowerCase()}`).digest('hex').slice(0, 24);
    this.client = new WhirlpoolClient(this.config, this.log, {
      cachePath: path.join(api.user.storagePath(), PLUGIN_NAME, `${this.accountKey}.json`),
    });
    this.client.on('authFailed', (error) => this.authFailed(error));
    this.events = new WhirlpoolEvents(this.client, this.log);
    this.events.on('attributes', (said, attrs, timestamp) => {
      this.devices.get(said)?.applyAttributes(attrs, timestamp);
    });
    this.events.on('connected', () => {
      this.log.debug('Whirlpool push updates connected.');
      void this.poll();
    });
    api.on('didFinishLaunching', () => { void this.start(); });
    api.on('shutdown', () => this.shutdown());
  }

  configureAccessory(accessory) {
    if (!this.config || accessory.context.accountKey !== this.accountKey) return;
    this.accessories.set(accessory.UUID, accessory);
    this.registeredAccessories.add(accessory.UUID);
  }

  updateAccessory(accessory) {
    // Homebridge's cache updater also inserts unknown accessories. Updating a
    // newly constructed accessory before registration prevents it from ever
    // reaching the HAP bridge and makes cache serialization fail.
    if (!this.stopped && this.registeredAccessories.has(accessory.UUID)) {
      this.api.updatePlatformAccessories([accessory]);
    }
  }

  override(said) { return this.config.devices.find((item) => item.said === said) || {}; }

  createController(accessory, device) {
    const controller = new WhirlpoolAccessory(this, accessory, device, this.override(device.info.said));
    this.controllers.set(device.info.said, controller);
    return controller;
  }

  restoreCachedDevices() {
    for (const accessory of [...this.accessories.values()]) {
      const info = accessory.context.whirlpool;
      if (!info || !['aircon', 'laundry'].includes(info.kind) || typeof info.said !== 'string') continue;
      if (this.override(info.said).exclude) {
        this.removeAccessory(accessory);
        continue;
      }
      const device = new WhirlpoolDevice(info, this.client);
      this.devices.set(info.said, device);
      this.createController(accessory, device);
    }
  }

  async start() {
    if (this.started || this.stopped) return;
    this.started = true;
    this.restoreCachedDevices();
    await this.client.loadSession();
    await this.discover();
    if (this.stopped || this.client.halted) return;
    this.pollTimer = setInterval(() => { void this.poll(); }, this.config.pollInterval * 1000);
    this.pollTimer.unref?.();
    this.discoveryTimer = setInterval(() => { void this.discover(); }, this.config.discoveryInterval * 1000);
    this.discoveryTimer.unref?.();
  }

  async discover() {
    if (this.stopped || this.discovering || this.client.halted) return;
    this.discovering = true;
    try {
      const result = await this.client.discover();
      if (this.stopped) return;
      this.retryDelay = 30000;
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
      await this.reconcile(result);
      if (!result.devices.length) this.log.warn('No supported air conditioners, washers, or dryers were found for this account. Check the brand and region.');
      for (const item of result.unsupported) this.log.debug(`Unsupported appliance model: ${item.dataModel} (${item.category}).`);
      if (this.config.enablePush && this.devices.size > 0 && !this.stopped) this.events.start([...this.devices.keys()]);
    } catch (error) {
      if (!this.stopped && !(error instanceof AuthenticationError)) {
        this.log.warn(`Whirlpool discovery: ${error.message} Retrying automatically.`);
        this.scheduleDiscoveryRetry();
      }
    } finally { this.discovering = false; }
  }

  scheduleDiscoveryRetry() {
    if (this.retryTimer || this.stopped || this.client.halted) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.discover();
    }, this.retryDelay);
    this.retryTimer.unref?.();
    this.retryDelay = Math.min(this.retryDelay * 2, 300000);
  }

  async reconcile(result) {
    const discovered = new Set(result.devices.map((d) => d.said));
    for (const info of result.devices) {
      const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${this.accountKey}:${info.said}`);
      const override = this.override(info.said);
      let accessory = this.accessories.get(uuid);
      if (override.exclude) {
        if (accessory) this.removeAccessory(accessory);
        continue;
      }
      let device = this.devices.get(info.said);
      if (!device) {
        device = new WhirlpoolDevice(info, this.client);
        this.devices.set(info.said, device);
      } else device.info = { ...info };
      if (!accessory) {
        const category = info.kind === 'aircon' ? this.api.hap.Categories.AIR_CONDITIONER : this.api.hap.Categories.SENSOR;
        accessory = new this.api.platformAccessory(override.name || info.name, uuid, category);
        this.accessories.set(uuid, accessory);
        this.log.info(`Discovered ${override.name || info.name} (${info.kind === 'aircon' ? 'air conditioner' : 'washer/dryer'}).`);
      }
      // Keep only appliance identity in the Homebridge cache; never credentials or tokens.
      accessory.context.accountKey = this.accountKey;
      accessory.context.whirlpool = { ...info };
    }

    for (const accessory of [...this.accessories.values()]) {
      const info = accessory.context.whirlpool;
      if (!info) continue;
      const excluded = this.override(info.said).exclude;
      const routeAuthoritative = result.ownedOk && (['available', 'empty'].includes(result.sharedStatus) ||
        (!info.shared && result.sharedStatus === 'endpoint_unavailable'));
      if (excluded || (!discovered.has(info.said) && routeAuthoritative)) this.removeAccessory(accessory);
    }

    await this.poll();
    if (this.stopped) return;
    for (const accessory of this.accessories.values()) {
      const info = accessory.context.whirlpool;
      const device = info && this.devices.get(info.said);
      if (!device) continue;
      let controller = this.controllers.get(info.said);
      if (!controller) controller = this.createController(accessory, device);
      else {
        controller.name = this.override(info.said).name || info.name;
        accessory.displayName = controller.name;
        controller.update();
      }
    }
    // Construct all services first, then register, then persist. Derive pending
    // registrations from current state so a previous interrupted attempt can
    // be retried without losing the new accessory.
    const additions = [...this.accessories.values()].filter((a) => !this.registeredAccessories.has(a.UUID));
    if (additions.length) {
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, additions);
      for (const accessory of additions) this.registeredAccessories.add(accessory.UUID);
    }
    const registered = [...this.accessories.values()].filter((a) => this.registeredAccessories.has(a.UUID));
    if (registered.length) this.api.updatePlatformAccessories(registered);
    this.events.setDevices([...this.devices.keys()]);
    if (this.devices.size === 0) this.events.stop();
  }

  removeAccessory(accessory) {
    const said = accessory.context.whirlpool?.said;
    if (said) {
      this.controllers.get(said)?.close();
      this.controllers.delete(said);
      this.devices.get(said)?.close();
      this.devices.delete(said);
      this.pollFailures.delete(said);
    }
    this.accessories.delete(accessory.UUID);
    if (this.registeredAccessories.delete(accessory.UUID)) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }
    this.log.info(`Removed ${accessory.displayName} from Homebridge.`);
  }

  async poll() {
    if (this.polling || this.stopped || this.client.halted) return;
    this.polling = true;
    try {
      const devices = [...this.devices.values()];
      const results = await parallelLimit(devices, 3, (device) => this.client.refreshDevice(device));
      results.forEach((result, index) => {
        const device = devices[index];
        if (result.status === 'rejected') {
          if (!this.pollFailures.has(device.info.said) && !this.stopped && !(result.reason instanceof AuthenticationError)) {
            this.log.warn(`Cannot update ${device.info.name}: ${result.reason.message}`);
            this.pollFailures.add(device.info.said);
          }
        } else if (this.pollFailures.delete(device.info.said)) this.log.info(`${device.info.name} cloud status recovered.`);
      });
    } finally { this.polling = false; }
  }

  authFailed(error) {
    this.log.error(error.message);
    this.events.stop();
    clearInterval(this.pollTimer);
    clearInterval(this.discoveryTimer);
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    for (const device of this.devices.values()) device.markUnavailable();
  }

  shutdown() {
    this.stopped = true;
    clearInterval(this.pollTimer);
    clearInterval(this.discoveryTimer);
    clearTimeout(this.retryTimer);
    this.events?.stop();
    for (const controller of this.controllers.values()) controller.close();
    for (const device of this.devices.values()) device.close();
    this.client?.close();
  }
}

module.exports = { WhirlpoolPlatform, PLUGIN_NAME, PLATFORM_NAME, parallelLimit };
