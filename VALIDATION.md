# Release validation — 1.0.0

Date: 2026-10-16

- JavaScript syntax checks: passed.
- Automated tests: 46 passed, 0 failed.
- Real Homebridge 1.8.0 API compatibility check: native AC services and 24.5 °C status passed without characteristic warnings.
- Real Homebridge 2.4.0 API compatibility check: native AC services and 24.5 °C status passed without characteristic warnings.
- Installable npm tarball: produced with npm pack; all prepack checks passed.
- Clean production-only package install: passed; only the plugin and ws were installed into the isolated test directory.
- Installed-package end-to-end fixture check: authenticated against mocked cloud responses, tolerated optional shared HTTP 404, discovered an appliance, registered a real Homebridge PlatformAccessory, and read its native temperature characteristic successfully.
- WebSocket tests: real local socket server verified authentication framing, subscriptions, push delivery, and invalid-token renewal.
- Settings schema and package/platform aliases: validated.
- Runtime used for local verification: Node.js 24.19.0, npm 11.9.0.

The suite checks protocol fixtures and HomeKit behavior. No real Whirlpool account was used and no physical appliance was operated. Live authentication and appliance commands require validation after installation.

Source includes a CI matrix for Node.js 22, 24, and 26; only Node.js 24 was executed in this local build.

GitHub publication and npm publication have not been performed.
