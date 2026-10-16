'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { WhirlpoolAccessory } = require('../lib/accessory');
const { WhirlpoolDevice, descriptor, AC, LAUNDRY } = require('../lib/device');
const { hap, logger, config, rawInfo, acSnapshot, laundrySnapshot, api, TestAccessory } = require('./helpers');

function fixture(t, kind = 'aircon', options = {}) {
  const commands = [];
  const client = { sendCommand: async (_said, attributes) => commands.push(attributes), refreshDevice: async () => {} };
  const info = descriptor(rawInfo('TEST', kind === 'aircon' ? 'AirConditioner_v1' : 'Washer_v1'));
  const device = new WhirlpoolDevice(info, client);
  device.applySnapshot(kind === 'aircon' ? acSnapshot() : laundrySnapshot());
  const platform = { api: api(), log: logger(), config: config(options) };
  const accessory = new TestAccessory('Test Appliance', hap.uuid.generate('fixture'));
  const warnings = [];
  accessory.on('characteristic-warning', (warning) => warnings.push(warning));
  const controller = new WhirlpoolAccessory(platform, accessory, device, options.override);
  t.after(() => { controller.close(); device.close(); });
  return { device, platform, accessory, controller, commands, warnings };
}

function char(f, Type, subtype, Characteristic) {
  return f.accessory.getServiceById(Type, subtype).getCharacteristic(Characteristic);
}

test('AC exposes a native heater/cooler, fan, temperature, humidity, and supported switches', async (t) => {
  const f = fixture(t);
  assert(f.accessory.getServiceById(hap.Service.HeaterCooler, 'climate').isPrimaryService);
  assert(f.accessory.getServiceById(hap.Service.Fanv2, 'fan'));
  assert.equal(await char(f, hap.Service.HeaterCooler, 'climate', hap.Characteristic.CurrentTemperature).handleGetRequest(), 24.5);
  assert.equal(await char(f, hap.Service.HumiditySensor, 'humidity', hap.Characteristic.CurrentRelativeHumidity).handleGetRequest(), 46);
  assert.equal(await char(f, hap.Service.HeaterCooler, 'climate', hap.Characteristic.CurrentHeaterCoolerState).handleGetRequest(), hap.Characteristic.CurrentHeaterCoolerState.COOLING);
  for (const subtype of ['eco', 'quiet', 'turbo', 'display']) assert(f.accessory.getServiceById(hap.Service.Switch, subtype));
  assert.equal(f.warnings.length, 0);
});

test('HomeKit temperature writes use tenths of a degree and update the shared setpoint', async (t) => {
  const f = fixture(t);
  const cooling = char(f, hap.Service.HeaterCooler, 'climate', hap.Characteristic.CoolingThresholdTemperature);
  await cooling.handleSetRequest(23);
  assert.equal(f.commands[0][AC.targetTemperature], '230');
  const heating = char(f, hap.Service.HeaterCooler, 'climate', hap.Characteristic.HeatingThresholdTemperature);
  assert.equal(await heating.handleGetRequest(), 23);
  await assert.rejects(f.controller.setTemperature(31), /outside/);
});

test('native heat, cool, auto, and fan-only controls send the SDK mode values', async (t) => {
  const f = fixture(t);
  const target = char(f, hap.Service.HeaterCooler, 'climate', hap.Characteristic.TargetHeaterCoolerState);
  await target.handleSetRequest(hap.Characteristic.TargetHeaterCoolerState.HEAT);
  assert.deepEqual(f.commands.at(-1), { [AC.modeSet]: '3', [AC.power]: '1' });
  await target.handleSetRequest(hap.Characteristic.TargetHeaterCoolerState.COOL);
  assert.equal(f.commands.at(-1)[AC.modeSet], '1');
  await target.handleSetRequest(hap.Characteristic.TargetHeaterCoolerState.AUTO);
  assert.equal(f.commands.at(-1)[AC.modeSet], '4');
  assert.equal(await char(f, hap.Service.HeaterCooler, 'climate', hap.Characteristic.Active).handleGetRequest(), hap.Characteristic.Active.ACTIVE);
  assert.equal(await char(f, hap.Service.Fanv2, 'fan', hap.Characteristic.Active).handleGetRequest(), hap.Characteristic.Active.INACTIVE);
  await char(f, hap.Service.Fanv2, 'fan', hap.Characteristic.Active).handleSetRequest(hap.Characteristic.Active.ACTIVE);
  assert.equal(f.commands.at(-1)[AC.modeSet], '2');
  assert.equal(await char(f, hap.Service.HeaterCooler, 'climate', hap.Characteristic.Active).handleGetRequest(), hap.Characteristic.Active.INACTIVE);
  await char(f, hap.Service.HeaterCooler, 'climate', hap.Characteristic.Active).handleSetRequest(hap.Characteristic.Active.ACTIVE);
  assert.equal(f.commands.at(-1)[AC.modeSet], '4');
});

test('fan speeds, automatic fan, swing, and display map to their exact wire values', async (t) => {
  const f = fixture(t);
  const rotation = char(f, hap.Service.Fanv2, 'fan', hap.Characteristic.RotationSpeed);
  for (const [percent, expected] of [[0, '1'], [33, '2'], [66, '4'], [100, '6']]) {
    await rotation.handleSetRequest(percent);
    assert.equal(f.commands.at(-1)[AC.fan], expected);
  }
  await char(f, hap.Service.Fanv2, 'fan', hap.Characteristic.TargetFanState).handleSetRequest(hap.Characteristic.TargetFanState.AUTO);
  assert.equal(f.commands.at(-1)[AC.fan], '1');
  await char(f, hap.Service.HeaterCooler, 'climate', hap.Characteristic.SwingMode).handleSetRequest(hap.Characteristic.SwingMode.SWING_DISABLED);
  assert.equal(f.commands.at(-1)[AC.swing], '0');
  await char(f, hap.Service.Switch, 'display', hap.Characteristic.On).handleSetRequest(false);
  assert.equal(f.commands.at(-1)[AC.display], '0');
});

test('offline devices fail HomeKit reads and writes without sending cloud commands', async (t) => {
  const f = fixture(t);
  f.device.markUnavailable();
  const active = char(f, hap.Service.HeaterCooler, 'climate', hap.Characteristic.Active);
  await assert.rejects(active.handleGetRequest());
  await assert.rejects(active.handleSetRequest(0));
  assert.equal(f.commands.length, 0);
  assert.equal(await char(f, hap.Service.TemperatureSensor, 'temperature', hap.Characteristic.StatusActive).handleGetRequest(), false);
  assert.equal(await char(f, hap.Service.TemperatureSensor, 'temperature', hap.Characteristic.StatusFault).handleGetRequest(), hap.Characteristic.StatusFault.GENERAL_FAULT);
});

test('cloud commands never run during cached HomeKit reads', async (t) => {
  const f = fixture(t);
  f.device.client.sendCommand = async () => { throw new Error('Unexpected network request'); };
  f.device.client.refreshDevice = async () => { throw new Error('Unexpected network request'); };
  for (let i = 0; i < 20; i++) {
    assert.equal(await char(f, hap.Service.HeaterCooler, 'climate', hap.Characteristic.CurrentTemperature).handleGetRequest(), 24.5);
  }
});

test('turning off the extra-control option removes restored switches', async (t) => {
  const f = fixture(t);
  assert(f.accessory.getServiceById(hap.Service.Switch, 'eco'));
  f.platform.config.exposeExtraControls = false;
  f.controller.update();
  assert.equal(f.accessory.getServiceById(hap.Service.Switch, 'eco'), undefined);
  assert(f.accessory.getServiceById(hap.Service.HeaterCooler, 'climate'));
});

test('unsupported optional attributes do not create humidity or extra-control services', async (t) => {
  const f = fixture(t);
  for (const key of [AC.humidity, AC.eco, AC.quiet, AC.turbo, AC.display]) f.device.attributes.delete(key);
  f.controller.update();
  assert.equal(f.accessory.getServiceById(hap.Service.HumiditySensor, 'humidity'), undefined);
  assert.equal(f.accessory.getServiceById(hap.Service.Switch, 'eco'), undefined);
});

test('laundry sensors preserve phase, timer, detergent, door, and cycle completion semantics', async (t) => {
  const f = fixture(t, 'laundry');
  assert.equal(await char(f, hap.Service.OccupancySensor, 'running', hap.Characteristic.OccupancyDetected).handleGetRequest(), 1);
  assert.equal(await char(f, hap.Service.OccupancySensor, 'running', f.controller.custom.MachineState).handleGetRequest(), 'cycle_washing');
  assert.equal(await char(f, hap.Service.OccupancySensor, 'running', hap.Characteristic.RemainingDuration).handleGetRequest(), 3600);
  assert.equal(await char(f, hap.Service.OccupancySensor, 'running', f.controller.custom.Detergent).handleGetRequest(), '50%');
  const end = Date.parse(f.device.cycleEndTime);
  assert(Math.abs(end - Date.now() - 3600000) < 2000);
  f.device.applyAttributes({ [LAUNDRY.state]: '10' }, 2000);
  assert.equal(await char(f, hap.Service.OccupancySensor, 'running', hap.Characteristic.OccupancyDetected).handleGetRequest(), 0);
  assert.equal(await char(f, hap.Service.ContactSensor, 'complete', hap.Characteristic.ContactSensorState).handleGetRequest(), 1);
  assert.equal(await char(f, hap.Service.OccupancySensor, 'running', hap.Characteristic.RemainingDuration).handleGetRequest(), 0);
  assert(Math.abs(Date.parse(f.device.cycleEndTime) - Date.now()) < 2000);
  f.device.applyAttributes({ [LAUNDRY.door]: '1' }, 3000);
  assert.equal(await char(f, hap.Service.ContactSensor, 'door', hap.Characteristic.ContactSensorState).handleGetRequest(), 1);
  assert.equal(f.device.laundryState, 'door_open');
  assert.equal(f.commands.length, 0);
});

test('all laundry machine states are handled without fabricated running state', async (t) => {
  const f = fixture(t, 'laundry');
  for (let state = 0; state <= 18; state++) {
    f.device.applyAttributes({ [LAUNDRY.state]: String(state) }, 3000 + state);
    assert.equal(f.device.running, state === 7 || state === 8);
    assert.notEqual(f.device.laundryState, 'unknown');
  }
});

test('late REST snapshots and older push events cannot overwrite newer data', async () => {
  const device = new WhirlpoolDevice(descriptor(rawInfo()), {});
  device.applySnapshot(acSnapshot());
  device.applyAttributes({ [AC.currentTemperature]: '270' }, 3000);
  device.applySnapshot(acSnapshot({ [AC.currentTemperature]: '180' }), Date.now() - 1000);
  assert.equal(device.numeric(AC.currentTemperature), 270);
  device.applyAttributes({ [AC.currentTemperature]: '190' }, 2000);
  assert.equal(device.numeric(AC.currentTemperature), 270);
  device.close();
});

test('complete snapshots cannot leave an omitted online flag or measurement looking current', () => {
  const device = new WhirlpoolDevice(descriptor(rawInfo()), {});
  device.applySnapshot(acSnapshot());
  assert.equal(device.available, true);
  device.applySnapshot({ attributes: { [AC.power]: { value: '1' } } });
  assert.equal(device.available, false);
  assert.equal(device.numeric(AC.currentTemperature), null);
  device.close();
});

test('device commands are serialized, including after one request fails', async () => {
  const order = [];
  let active = 0;
  const client = { refreshDevice: async () => {}, sendCommand: async (_said, attrs) => {
    assert.equal(active, 0);
    active++;
    await new Promise((resolve) => setImmediate(resolve));
    order.push(attrs[AC.targetTemperature]);
    active--;
    if (order.length === 1) throw new Error('First request rejected');
  } };
  const device = new WhirlpoolDevice(descriptor(rawInfo()), client);
  device.applySnapshot(acSnapshot());
  const first = device.command({ [AC.targetTemperature]: '230' });
  const second = device.command({ [AC.targetTemperature]: '240' });
  await assert.rejects(first, /rejected/);
  await second;
  assert.deepEqual(order, ['230', '240']);
  assert.equal(device.numeric(AC.targetTemperature), 240);
  device.close();
});
