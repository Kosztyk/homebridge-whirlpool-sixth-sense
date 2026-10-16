# Release validation — 1.0.2

Date: 2026-10-16

Scope:
- Generate new Homebridge settings without an unsolicited per-device row.
- Expose air conditioners as native AC accessories.
- Fix new accessories entering the cache before registration.

Verified results:
- JavaScript syntax checks: passed.
- Complete automated suite: 56 passed, 0 failed.
- Real Homebridge UI form engine (@ng-formworks/core 21.7.0): reproduced the old default-only row, then confirmed the fixed schema creates zero rows for a new configuration and keeps an empty list empty when reopening it. Manually added valid rows retain their settings.
- Real Homebridge 2.4.0 BridgeService: reproduced the original missing-plugin cache error and duplicate UUID with the previous implementation; the corrected registration order passes the same test.
- Real bridge/cache tests: new discovery, later sensor additions, rediscovery, cache serialization, restoration after restart, and mixed AC/laundry discovery all passed.
- AC identity: AIR_CONDITIONER category, primary native HeaterCooler service, and linked fan service. Legacy cached OTHER-category accessories migrate without changing UUIDs.
- npm pack completed successfully, including all prepack checks.
- Clean production-only tarball install: only the plugin and ws were installed. The installed package authenticated using cloud fixtures, tolerated an unused legacy settings row, registered one actual HAP accessory, serialized it to disk, and returned the expected native temperature.
- Node.js 24.19.0, npm 11.9.0. CI also covers Node.js 22 and 26, which were not executed locally.

No real account credentials were used in tests and no physical appliance commands were sent. Live operation should be checked after updating and restarting Homebridge.

Version 1.0.2 has not been pushed to GitHub or published to npm by this workflow.
