# Release validation — 1.0.1

Date: 2026-10-16

Reported failure: Homebridge loaded version 1.0.0 but stopped during configuration with "Each device override needs its SAID", before account login or appliance discovery.

Fix: ignore optional per-device rows without a nonempty string SAID and log a row-number warning. Preserve valid overrides and their existing validation. The Homebridge settings schema now defaults the list to empty and permits unused rows.

- JavaScript syntax checks: passed.
- Automated suite: 49 passed, 0 failed.
- Regression: blank/default-only rows do not block configuration; valid names, exclusions, and temperature limits still apply.
- Regression: startup with a blank GUI row signs in against cloud fixtures, handles shared HTTP 404, discovers an appliance, and registers its native HomeKit service.
- Regression: the settings schema accepts an unused row and defaults devices to an empty list.
- Existing tests cover cloud authentication/refresh, commands, native HomeKit mappings, offline errors, discovery recovery, and real local WebSocket event delivery.
- npm pack: passed, including prepack syntax checks and the complete test suite.
- Runtime: Node.js 24.19.0, npm 11.9.0.

Tests use fixtures, without real account credentials or physical appliance commands. Live account/device operation remains to be checked after the startup blocker is removed.

Version 1.0.1 has not been pushed to GitHub or published to npm by this patch workflow.
