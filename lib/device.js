'use strict';

const { EventEmitter } = require('node:events');

const AC = Object.freeze({
  online: 'Online', power: 'Sys_OpSetPowerOn', mode: 'Cavity_OpStatusMode',
  modeSet: 'Cavity_OpSetMode', currentTemperature: 'Sys_OpStatusDisplayTemp',
  targetTemperature: 'Sys_OpSetTargetTemp', humidity: 'Sys_OpStatusDisplayHumidity',
  targetHumidity: 'Sys_OpSetTargetHumidity', fan: 'Cavity_OpSetFanSpeed',
  swing: 'Cavity_OpSetHorzLouverSwing', turbo: 'Cavity_OpSetTurboMode',
  eco: 'Sys_OpSetEcoModeEnabled', quiet: 'Sys_OpSetQuietModeEnabled',
  display: 'Sys_DisplaySetBrightness',
});
const LAUNDRY = Object.freeze({
  state: 'Cavity_CycleStatusMachineState', door: 'Cavity_OpStatusDoorOpen',
  remaining: 'Cavity_TimeStatusEstTimeRemaining', detergent: 'WashCavity_OpStatusBulkDispense1Level',
});
const MACHINE_STATES = [
  'standby', 'setting', 'delay_countdown', 'delay_paused', 'smart_delay', 'smart_grid_pause',
  'pause', 'running_maincycle', 'running_postcycle', 'exception', 'complete', 'power_failure',
  'service_diagnostic_mode', 'factory_diagnostic_mode', 'life_test', 'customer_focus_mode',
  'demo_mode', 'hard_stop_or_error', 'system_initialize',
];
const CYCLE_PHASES = ['Filling', 'Rinsing', 'Sensing', 'Soaking', 'Spinning', 'Washing'];

function descriptor(raw, shared = false) {
  if (!raw || typeof raw !== 'object' || typeof raw.SAID !== 'string' || !raw.SAID.trim() ||
    typeof raw.DATA_MODEL_KEY !== 'string' || typeof raw.CATEGORY_NAME !== 'string' ||
    typeof raw.APPLIANCE_NAME !== 'string') throw new Error('Invalid appliance descriptor.');
  const model = raw.DATA_MODEL_KEY.toLowerCase();
  const kind = model.includes('airconditioner') ? 'aircon' :
    /washer|dryer/.test(model) ? 'laundry' : 'unsupported';
  return {
    said: raw.SAID, name: raw.APPLIANCE_NAME || 'Whirlpool Appliance',
    dataModel: raw.DATA_MODEL_KEY, category: raw.CATEGORY_NAME,
    model: typeof raw.MODEL_NO === 'string' ? raw.MODEL_NO : '',
    serial: typeof raw.SERIAL === 'string' ? raw.SERIAL : '', kind, shared,
  };
}

class WhirlpoolDevice extends EventEmitter {
  constructor(info, client) {
    super();
    this.info = { ...info };
    this.client = client;
    this.attributes = new Map();
    this.reachable = false;
    this.updatedAt = 0;
    this.cycleEndTime = '';
    this.lastHvacMode = '1';
    this.queue = Promise.resolve();
    this.closed = false;
  }

  has(key) { return this.attributes.has(key); }
  value(key) { return this.attributes.get(key)?.value; }
  numeric(key) {
    const value = this.value(key);
    if (value === undefined || value === null || value === '') return null;
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  }
  bool(key) {
    const v = this.value(key);
    return v === '1' ? true : v === '0' ? false : null;
  }
  get available() { return this.reachable && this.bool(AC.online) === true; }
  get mode() {
    const raw = this.value(AC.mode);
    if (['1', '7'].includes(raw)) return 'cool';
    if (['3', '6'].includes(raw)) return 'heat';
    if (['2', '5'].includes(raw)) return 'fan';
    return null;
  }
  get sixthSense() { return this.value(AC.modeSet) === '4'; }
  get running() {
    const state = this.numeric(LAUNDRY.state);
    return state === 7 || state === 8;
  }
  get laundryState() {
    if (this.bool(LAUNDRY.door) === true) return 'door_open';
    const state = this.numeric(LAUNDRY.state);
    if (state === 7) {
      const phase = CYCLE_PHASES.find((p) => this.bool(`WashCavity_CycleStatus${p}`) === true);
      if (phase) return `cycle_${phase.toLowerCase()}`;
    }
    return MACHINE_STATES[state] || 'unknown';
  }

  applySnapshot(data, startedAt = Date.now()) {
    if (!data || !data.attributes || typeof data.attributes !== 'object' || Array.isArray(data.attributes)) {
      throw new Error('Invalid appliance status response.');
    }
    // REST returns a complete attribute snapshot. Do not keep an omitted Online
    // flag or optional measurement indefinitely, but preserve newer push data.
    for (const [key, entry] of this.attributes) {
      if (!Object.hasOwn(data.attributes, key) && entry.receivedAt <= startedAt) this.attributes.delete(key);
    }
    this.applyAttributes(data.attributes, undefined, startedAt);
  }

  applyAttributes(attrs, timestamp, snapshotStartedAt) {
    const wasRunning = this.running;
    const now = Date.now();
    const isSnapshot = snapshotStartedAt !== undefined;
    let timeChanged = false;
    for (const [key, raw] of Object.entries(attrs)) {
      const value = raw && typeof raw === 'object' ? raw.value : raw;
      if (!['string', 'number', 'boolean'].includes(typeof value)) continue;
      const old = this.attributes.get(key);
      const updated = Number(raw && typeof raw === 'object' ? raw.updateTime : timestamp);
      const sourceTime = Number.isFinite(updated) ? updated : 0;
      // An in-flight REST response must not overwrite a more recent push/command.
      if (old && isSnapshot && old.receivedAt > snapshotStartedAt) continue;
      if (old && sourceTime && old.sourceTime && sourceTime < old.sourceTime) continue;
      this.attributes.set(key, { value: typeof value === 'boolean' ? (value ? '1' : '0') : String(value),
        sourceTime, receivedAt: now });
      if (key === LAUNDRY.remaining || key === LAUNDRY.state) timeChanged = true;
    }
    if (['1', '3', '4'].includes(this.value(AC.modeSet))) this.lastHvacMode = this.value(AC.modeSet);
    if (this.info.kind === 'laundry' && timeChanged) {
      const seconds = this.numeric(LAUNDRY.remaining);
      if (this.running && seconds !== null && seconds >= 0 && seconds <= 604800) {
        this.cycleEndTime = new Date(now + seconds * 1000).toISOString();
      } else if (wasRunning && [0, 10].includes(this.numeric(LAUNDRY.state))) {
        this.cycleEndTime = new Date(now).toISOString();
      } else if (!this.running && ![0, 10].includes(this.numeric(LAUNDRY.state))) {
        this.cycleEndTime = '';
      }
    }
    this.reachable = true;
    this.updatedAt = now;
    this.emit('update');
  }

  markUnavailable() {
    if (!this.reachable) return;
    this.reachable = false;
    this.emit('update');
  }

  async command(attributes) {
    const run = this.queue.catch(() => {}).then(async () => {
      if (this.closed || !this.available) throw new Error('Appliance is offline.');
      await this.client.sendCommand(this.info.said, attributes);
      if (this.closed) return;
      const optimistic = { ...attributes };
      if (attributes[AC.modeSet]) {
        optimistic[AC.mode] = attributes[AC.modeSet] === '4' ? '5' : attributes[AC.modeSet];
      }
      this.applyAttributes(optimistic);
      clearTimeout(this.refreshTimer);
      this.refreshTimer = setTimeout(() => {
        this.client.refreshDevice(this).catch(() => {});
      }, 1500);
      this.refreshTimer.unref?.();
    });
    this.queue = run;
    return run;
  }

  close() {
    this.closed = true;
    clearTimeout(this.refreshTimer);
    this.removeAllListeners();
  }
}

module.exports = { WhirlpoolDevice, descriptor, AC, LAUNDRY, MACHINE_STATES };
