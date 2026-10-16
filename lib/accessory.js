'use strict';

const { AC, LAUNDRY } = require('./device');
const { version } = require('../package.json');

function customCharacteristics(hap) {
  const C = hap.Characteristic;
  function make(name, key, props) {
    class Custom extends C {
      static UUID = hap.uuid.generate(`homebridge-whirlpool-sixth-sense:${key}`);
      constructor() {
        super(name, Custom.UUID, { perms: [hap.Perms.PAIRED_READ, hap.Perms.NOTIFY], ...props });
        this.value = this.getDefaultValue();
      }
    }
    return Custom;
  }
  return {
    MachineState: make('Machine State', 'machine-state', { format: hap.Formats.STRING, maxLen: 64 }),
    EndTime: make('Estimated End Time', 'end-time', { format: hap.Formats.STRING, maxLen: 40 }),
    Detergent: make('Detergent Level', 'detergent-level', { format: hap.Formats.STRING, maxLen: 16 }),
  };
}

class WhirlpoolAccessory {
  constructor(platform, accessory, device, override = {}) {
    this.platform = platform;
    this.api = platform.api;
    this.hap = this.api.hap;
    this.S = this.hap.Service;
    this.C = this.hap.Characteristic;
    this.accessory = accessory;
    this.device = device;
    this.override = override;
    this.name = override.name || device.info.name;
    this.bindings = new Map();
    this.owned = new Set();
    this.custom = platform.custom || (platform.custom = customCharacteristics(this.hap));
    this.minTemperature = override.minTemperature ?? 16;
    this.maxTemperature = override.maxTemperature ?? 30;
    this.listener = () => this.update();
    this.device.on('update', this.listener);
    this.setupInformation();
    this.update();
  }

  error() {
    return new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }

  setupInformation() {
    const info = this.accessory.getService(this.S.AccessoryInformation);
    info.setCharacteristic(this.C.Manufacturer, this.platform.config.brand)
      .setCharacteristic(this.C.Model, (this.device.info.model || this.device.info.dataModel || 'Sixth Sense').slice(0, 64))
      .setCharacteristic(this.C.SerialNumber, (this.device.info.serial || this.device.info.said).slice(0, 64))
      .setCharacteristic(this.C.FirmwareRevision, version);
    this.accessory.displayName = this.name;
    this.accessory.on('identify', (_paired, callback) => {
      this.platform.log.info(`Identified ${this.name}.`);
      callback();
    });
  }

  service(Type, name, subtype) {
    let service = this.accessory.getServiceById(Type, subtype);
    if (!service) {
      service = this.accessory.addService(Type, name, subtype);
      this.changed = true;
    }
    this.owned.add(service);
    service.displayName = name;
    if (service.getCharacteristic(this.C.Name).value !== name) service.setCharacteristic(this.C.Name, name);
    if (this.C.ConfiguredName) {
      if (!service.testCharacteristic(this.C.ConfiguredName)) service.addCharacteristic(this.C.ConfiguredName);
      if (service.getCharacteristic(this.C.ConfiguredName).value !== name) service.setCharacteristic(this.C.ConfiguredName, name);
    }
    return service;
  }

  bind(service, Type, getter, setter, props, offlineAllowed = false) {
    let char;
    if (service.testCharacteristic(Type)) char = service.getCharacteristic(Type);
    else {
      char = service.addCharacteristic(Type);
      this.changed = true;
    }
    if (props) {
      // HAP's default threshold values precede the appliance-specific range.
      // Set a valid initial value before changing props to avoid startup warnings.
      if (typeof char.value === 'number') {
        if (props.minValue !== undefined && char.value < props.minValue) char.value = props.minValue;
        if (props.maxValue !== undefined && char.value > props.maxValue) char.value = props.maxValue;
      }
      char.setProps(props);
    }
    let binding = this.bindings.get(char);
    if (!binding) {
      binding = { getter, setter, offlineAllowed };
      this.bindings.set(char, binding);
      char.onGet(() => this.read(binding));
      if (setter) char.onSet(async (value) => {
        if (!this.device.available) throw this.error();
        try { await binding.setter(value); }
        catch (error) {
          this.platform.log.warn(`Control failed for ${this.name}: ${error.message}`);
          throw this.error();
        }
      });
    } else Object.assign(binding, { getter, setter, offlineAllowed });
    return char;
  }

  read(binding) {
    if (!binding.offlineAllowed && !this.device.available) throw this.error();
    const value = binding.getter();
    if (value === undefined || value === null || (typeof value === 'number' && !Number.isFinite(value))) throw this.error();
    return value;
  }

  numeric(key, min, max, scale = 1) {
    const value = this.device.numeric(key);
    if (value === null) return null;
    const result = value / scale;
    return result >= min && result <= max ? result : null;
  }

  // Keep previously exposed optional services while cached devices await their first status.
  supports(key, Type, subtype) {
    return this.device.has(key) || (!this.device.updatedAt && Boolean(this.accessory.getServiceById(Type, subtype)));
  }

  sensorStatus(service) {
    this.bind(service, this.C.StatusActive, () => this.device.available, undefined, undefined, true);
    this.bind(service, this.C.StatusFault, () => this.device.available ? this.C.StatusFault.NO_FAULT : this.C.StatusFault.GENERAL_FAULT,
      undefined, undefined, true);
  }

  async setTemperature(value) {
    const temp = Number(value);
    if (!Number.isFinite(temp) || temp < this.minTemperature || temp > this.maxTemperature) throw new Error('Temperature is outside the configured range.');
    await this.device.command({ [AC.targetTemperature]: String(Math.round(temp) * 10) });
  }

  getSpeed() {
    const value = this.device.value(AC.fan);
    return ({ '0': 0, '1': 0, '2': 33, '4': 66, '6': 100 })[value] ?? null;
  }

  async setSpeed(value) {
    const percent = Number(value);
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) throw new Error('Invalid fan speed.');
    const speed = percent === 0 ? '1' : percent <= 33 ? '2' : percent <= 66 ? '4' : '6';
    await this.device.command({ [AC.fan]: speed });
  }

  setupAircon() {
    const C = this.C;
    const device = this.device;
    const climate = this.service(this.S.HeaterCooler, this.name, 'climate');
    climate.setPrimaryService(true);
    this.bind(climate, C.Active, () => {
      const power = device.bool(AC.power);
      return power === null ? null : power && (device.mode !== 'fan' || device.sixthSense) ? C.Active.ACTIVE : C.Active.INACTIVE;
    }, async (value) => {
      if (value === C.Active.INACTIVE) {
        // Both services describe mutually exclusive modes of one appliance.
        if (device.mode !== 'fan' || device.sixthSense) await device.command({ [AC.power]: '0' });
      } else {
        const attrs = { [AC.power]: '1' };
        if (device.mode === 'fan' && !device.sixthSense) attrs[AC.modeSet] = device.lastHvacMode;
        await device.command(attrs);
      }
    });
    this.bind(climate, C.TargetHeaterCoolerState, () => {
      if (device.sixthSense) return C.TargetHeaterCoolerState.AUTO;
      if (device.mode === 'heat') return C.TargetHeaterCoolerState.HEAT;
      if (device.mode === 'cool' || device.mode === 'fan') return C.TargetHeaterCoolerState.COOL;
      return null;
    }, async (value) => {
      const mode = ({ [C.TargetHeaterCoolerState.AUTO]: '4', [C.TargetHeaterCoolerState.HEAT]: '3', [C.TargetHeaterCoolerState.COOL]: '1' })[value];
      if (!mode) throw new Error('Invalid air-conditioner mode.');
      await device.command({ [AC.modeSet]: mode, [AC.power]: '1' });
    });
    this.bind(climate, C.CurrentHeaterCoolerState, () => {
      const power = device.bool(AC.power);
      if (power === null) return null;
      if (!power) return C.CurrentHeaterCoolerState.INACTIVE;
      if (device.mode === 'fan') return C.CurrentHeaterCoolerState.IDLE;
      const current = this.numeric(AC.currentTemperature, -40, 100, 10);
      const target = this.numeric(AC.targetTemperature, this.minTemperature, this.maxTemperature, 10);
      if (current === null || target === null) return null;
      if (device.mode === 'heat') return current < target ? C.CurrentHeaterCoolerState.HEATING : C.CurrentHeaterCoolerState.IDLE;
      if (device.mode === 'cool') return current > target ? C.CurrentHeaterCoolerState.COOLING : C.CurrentHeaterCoolerState.IDLE;
      return null;
    });
    this.bind(climate, C.CurrentTemperature, () => this.numeric(AC.currentTemperature, -40, 100, 10));
    const tempProps = { minValue: this.minTemperature, maxValue: this.maxTemperature, minStep: 1 };
    const target = () => this.numeric(AC.targetTemperature, this.minTemperature, this.maxTemperature, 10);
    this.bind(climate, C.CoolingThresholdTemperature, target, (value) => this.setTemperature(value), tempProps);
    this.bind(climate, C.HeatingThresholdTemperature, target, (value) => this.setTemperature(value), tempProps);
    this.bind(climate, C.TemperatureDisplayUnits, () => C.TemperatureDisplayUnits.CELSIUS,
      async (value) => { if (value !== C.TemperatureDisplayUnits.CELSIUS) throw new Error('This API reports temperatures in Celsius.'); },
      { validValues: [C.TemperatureDisplayUnits.CELSIUS] });

    const fan = this.service(this.S.Fanv2, `${this.name} Fan Only`, 'fan');
    this.bind(fan, C.Active, () => {
      const power = device.bool(AC.power);
      return power === null ? null : power && device.mode === 'fan' && !device.sixthSense ? C.Active.ACTIVE : C.Active.INACTIVE;
    }, async (value) => {
      if (value === C.Active.ACTIVE) await device.command({ [AC.modeSet]: '2', [AC.power]: '1' });
      else if (device.mode === 'fan' && !device.sixthSense) await device.command({ [AC.power]: '0' });
    });
    this.bind(fan, C.CurrentFanState, () => {
      const power = device.bool(AC.power);
      return power === null ? null : power && device.mode === 'fan' && !device.sixthSense ? C.CurrentFanState.BLOWING_AIR : C.CurrentFanState.INACTIVE;
    });
    for (const service of [climate, fan]) {
      if (device.has(AC.fan) || !device.updatedAt) {
        this.bind(service, C.RotationSpeed, () => this.getSpeed(), (value) => this.setSpeed(value));
      }
      if (device.has(AC.swing) || !device.updatedAt) {
        this.bind(service, C.SwingMode, () => {
          const swing = device.bool(AC.swing);
          return swing === null ? null : swing ? C.SwingMode.SWING_ENABLED : C.SwingMode.SWING_DISABLED;
        }, (value) => device.command({ [AC.swing]: value === C.SwingMode.SWING_ENABLED ? '1' : '0' }));
      }
    }
    if (device.has(AC.fan) || !device.updatedAt) {
      this.bind(fan, C.TargetFanState, () => {
        if (!device.has(AC.fan)) return null;
        return device.value(AC.fan) === '1' ? C.TargetFanState.AUTO : C.TargetFanState.MANUAL;
      }, (value) => device.command({ [AC.fan]: value === C.TargetFanState.AUTO ? '1' : '2' }));
    }

    if (this.supports(AC.currentTemperature, this.S.TemperatureSensor, 'temperature')) {
      const sensor = this.service(this.S.TemperatureSensor, `${this.name} Temperature`, 'temperature');
      this.bind(sensor, C.CurrentTemperature, () => this.numeric(AC.currentTemperature, -40, 100, 10));
      this.sensorStatus(sensor);
    }
    if (this.supports(AC.humidity, this.S.HumiditySensor, 'humidity')) {
      const sensor = this.service(this.S.HumiditySensor, `${this.name} Humidity`, 'humidity');
      this.bind(sensor, C.CurrentRelativeHumidity, () => this.numeric(AC.humidity, 0, 100));
      this.sensorStatus(sensor);
    }
    if (this.platform.config.exposeExtraControls) {
      for (const [key, label, attr] of [['eco', 'Eco', AC.eco], ['quiet', 'Quiet', AC.quiet], ['turbo', 'Turbo', AC.turbo], ['display', 'Display', AC.display]]) {
        if (!this.supports(attr, this.S.Switch, key)) continue;
        const toggle = this.service(this.S.Switch, `${this.name} ${label}`, key);
        this.bind(toggle, C.On, () => {
          if (key === 'display') {
            const brightness = device.numeric(attr);
            return brightness === null ? null : brightness > 0;
          }
          return device.bool(attr);
        }, (value) => device.command({ [attr]: key === 'display' ? (value ? '4' : '0') : (value ? '1' : '0') }));
      }
    }
  }

  setupLaundry() {
    const C = this.C;
    const device = this.device;
    const running = this.service(this.S.OccupancySensor, `${this.name} Running`, 'running');
    running.setPrimaryService(true);
    this.bind(running, C.OccupancyDetected, () => device.numeric(LAUNDRY.state) === null ? null :
      device.running ? C.OccupancyDetected.OCCUPANCY_DETECTED : C.OccupancyDetected.OCCUPANCY_NOT_DETECTED);
    this.bind(running, this.custom.MachineState, () => device.laundryState);
    this.sensorStatus(running);
    if (this.supports(LAUNDRY.remaining, this.S.OccupancySensor, 'running') && (device.has(LAUNDRY.remaining) || !device.updatedAt)) {
      this.bind(running, C.RemainingDuration, () => {
        const seconds = this.numeric(LAUNDRY.remaining, 0, 604800);
        return seconds === null ? null : device.running ? Math.floor(seconds) : 0;
      }, undefined, { maxValue: 604800 });
      this.bind(running, this.custom.EndTime, () => device.cycleEndTime);
    }
    if (device.has(LAUNDRY.detergent) || (!device.updatedAt && running.testCharacteristic(this.custom.Detergent))) {
      this.bind(running, this.custom.Detergent, () => ({
        '0': 'unknown', '1': 'empty', '2': '25%', '3': '50%', '4': '100%', '5': 'active',
      })[device.value(LAUNDRY.detergent)] || 'unknown');
    }
    if (this.supports(LAUNDRY.door, this.S.ContactSensor, 'door')) {
      const door = this.service(this.S.ContactSensor, `${this.name} Door`, 'door');
      this.bind(door, C.ContactSensorState, () => {
        const open = device.bool(LAUNDRY.door);
        return open === null ? null : open ? C.ContactSensorState.CONTACT_NOT_DETECTED : C.ContactSensorState.CONTACT_DETECTED;
      });
      this.sensorStatus(door);
    }
    const complete = this.service(this.S.ContactSensor, `${this.name} Cycle Complete`, 'complete');
    this.bind(complete, C.ContactSensorState, () => {
      const state = device.numeric(LAUNDRY.state);
      return state === null ? null : state === 10 ? C.ContactSensorState.CONTACT_NOT_DETECTED : C.ContactSensorState.CONTACT_DETECTED;
    });
    this.sensorStatus(complete);
  }

  update() {
    this.changed = false;
    this.owned.clear();
    if (this.device.info.kind === 'aircon') this.setupAircon();
    else this.setupLaundry();
    for (const service of [...this.accessory.services]) {
      if (service.UUID === this.S.AccessoryInformation.UUID || this.owned.has(service)) continue;
      for (const char of service.characteristics) this.bindings.delete(char);
      this.accessory.removeService(service);
      this.changed = true;
    }
    for (const [char, binding] of this.bindings) {
      try { char.updateValue(this.read(binding)); }
      catch { char.updateValue(this.error()); }
    }
    if (this.changed) this.platform.api.updatePlatformAccessories([this.accessory]);
  }

  close() {
    this.device.off('update', this.listener);
    this.bindings.clear();
  }
}

module.exports = { WhirlpoolAccessory, customCharacteristics };
