'use strict';

const BRANDS = ['Whirlpool', 'Maytag', 'KitchenAid'];
const REGIONS = ['EU', 'US'];

function number(value, fallback, min, max, name) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be a number from ${min} to ${max}.`);
  }
  return value;
}

function boolean(value, fallback, name) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error(`${name} must be true or false.`);
  return value;
}

function normalizeConfig(input = {}) {
  const brand = BRANDS.find((x) => x.toLowerCase() === String(input.brand || 'Whirlpool').toLowerCase());
  const region = String(input.region || 'EU').toUpperCase();
  if (!brand) throw new Error('Brand must be Whirlpool, Maytag, or KitchenAid.');
  if (!REGIONS.includes(region)) throw new Error('Region must be EU or US.');
  if (typeof input.username !== 'string' || !input.username.trim()) throw new Error('Enter your Whirlpool app email address.');
  if (typeof input.password !== 'string' || !input.password) throw new Error('Enter your Whirlpool app password.');
  const overrides = input.devices ?? [];
  if (!Array.isArray(overrides)) throw new Error('Devices must be an array.');
  const seen = new Set();
  const devices = overrides.map((d) => {
    if (!d || typeof d.said !== 'string' || !d.said.trim()) throw new Error('Each device override needs its SAID.');
    const said = d.said.trim();
    if (seen.has(said)) throw new Error('Device overrides must have unique SAIDs.');
    seen.add(said);
    const minTemperature = number(d.minTemperature, 16, 10, 30, 'Minimum temperature');
    const maxTemperature = number(d.maxTemperature, 30, 16, 35, 'Maximum temperature');
    if (minTemperature >= maxTemperature) throw new Error('Minimum temperature must be below maximum temperature.');
    return {
      said, name: typeof d.name === 'string' ? d.name.trim() : undefined,
      exclude: boolean(d.exclude, false, 'Exclude device'), minTemperature, maxTemperature,
    };
  });
  return {
    name: typeof input.name === 'string' && input.name.trim() ? input.name.trim() : 'Whirlpool Sixth Sense',
    username: input.username.trim(), password: input.password, brand, region, devices,
    pollInterval: number(input.pollInterval, 60, 30, 3600, 'Poll interval'),
    discoveryInterval: number(input.discoveryInterval, 900, 300, 86400, 'Discovery interval'),
    requestTimeout: number(input.requestTimeout, 10, 5, 30, 'Request timeout'),
    enablePush: boolean(input.enablePush, true, 'Enable push'),
    exposeExtraControls: boolean(input.exposeExtraControls, true, 'Extra AC controls'),
    debug: boolean(input.debug, false, 'Debug logging'),
  };
}

module.exports = { normalizeConfig, BRANDS, REGIONS };
