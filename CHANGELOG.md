# Changelog

## 1.0.4 — 2026-10-23

- Declare Homebridge compatibility as `^1.8.0 || ^2.0.0` so the plugin catalog recognizes Homebridge v2 support.
- Keep the supported stable Homebridge versions the same and update the package lock and installation examples.

## 1.0.3 — 2026-10-22

- Declare HAP transport support for the Homebridge catalog.
- Keep Homebridge in devDependencies only so installing the plugin does not install another Homebridge runtime.

## 1.0.2 — 2026-10-16

- Fix Homebridge UI creating a default per-device row before the user adds one.
- Start the optional device editor with zero rows; automatic discovery needs no SAID entry.
- Register new accessories before any cache update, fixing missing plugin association and duplicate UUID errors.
- Identify ACs with the air-conditioner category and a primary native HeaterCooler service with linked fan controls.
- Correct the category of cached ACs while preserving their UUIDs and configuration.
- Add tests using the actual settings renderer, Homebridge bridge, and persistent accessory cache.

## 1.0.1 — 2026-10-16

- Fix startup stopping before login when an optional per-device row has no SAID.
- Ignore incomplete device rows with a warning, preserving automatic discovery and valid overrides.
- Default the optional device list to empty and allow unused rows in the settings form.
- Add regression coverage for settings normalization and startup through cloud discovery.

## 1.0.0 — 2026-10-16

- Initial native Node.js Homebridge port of the supplied Whirlpool Home Assistant integration.
- Whirlpool, Maytag, and KitchenAid login for EU and US accounts; refresh-token sessions.
- Owned and shared discovery, including optional shared-endpoint HTTP 404 compatibility.
- Native air-conditioner controls, fan-only mode, temperature and humidity sensors.
- Supported Eco, Quiet, Turbo, and Display switches.
- Read-only laundry running, door, cycle-complete, phase, time, and detergent sensors.
- Push updates, polling fallback, offline errors, command serialization, and recovery.
- Per-device naming, exclusions, temperature limits, Homebridge UI form, and CI tests.
