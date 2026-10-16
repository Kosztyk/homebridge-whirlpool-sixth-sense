# Changelog

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
