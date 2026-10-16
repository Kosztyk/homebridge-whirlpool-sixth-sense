# Homebridge Whirlpool Sixth Sense

Whirlpool Sixth Sense air conditioners and washer/dryer sensors for Homebridge.

## Requirements

- Homebridge 1.8 or later, including Homebridge 2.x.
- Node.js 22.12+, 24.x, or 26.x.
- A Whirlpool, Maytag, or KitchenAid mobile-app account in the EU or US region.
- Appliances that are already registered, online, and working in that app.

## Supported appliances

| Appliance | Apple Home | Extra details in compatible HomeKit apps |
| --- | --- | --- |
| Air conditioner | Native Heater/Cooler with power, heat, cool, Sixth Sense auto, 16–30 °C target temperature; fan-only service; fan speed; swing | Same controls |
| Air conditioner sensors | Current temperature and humidity, when reported | Same sensors |
| Additional AC settings | Eco, Quiet, Turbo, and Display switches, only when the appliance reports these attributes | Same switches |
| Washer / dryer | Running occupancy sensor, door contact sensor when reported, cycle-complete contact sensor | Machine state / cycle phase, remaining seconds, estimated end time, detergent level when reported |

Washers and dryers are **read-only**, matching the supplied Home Assistant
integration. There are no invented start/stop or program-selection commands.
Ovens, refrigerators, and other appliance families are not exposed by this
version. Unknown data models are skipped and identified in debug logs.

Apple Home does not have a general laundry-status tile. `Running` uses an
occupancy sensor: detected means a main or post-cycle is running. `Cycle
Complete` uses a contact sensor: open means the machine reports Complete;
closed means it does not. `Door` reflects the actual reported door state.
These sensors can be used in Apple Home automations. Remaining duration and
custom status strings need an app that displays additional characteristics,
such as Eve or Home+; their exact presentation depends on that app.

## Install the supplied package

Copy `homebridge-whirlpool-sixth-sense-1.0.2.tgz` to your Homebridge host, then:

```bash
sudo npm install -g ./homebridge-whirlpool-sixth-sense-1.0.2.tgz
sudo systemctl restart homebridge
```

If Homebridge is managed another way, restart it using its usual service or
container controls. Open the plugin's **Settings** page in the Homebridge UI,
enter your app credentials, select the correct brand and region, save, and
restart Homebridge again. A child bridge is supported and recommended for
keeping this cloud connection independent of other plugins.

The package has not been published to npm by this project handoff. Searching
the Homebridge plugin catalog will work after the package is published and
indexed. The existing name `homebridge-whirlpool` belongs to another package;
this project uses `homebridge-whirlpool-sixth-sense`.

## Configuration

The plugin includes `config.schema.json` for the Homebridge settings form.
For manual configuration, add this object to `platforms` in `config.json`:

```json
{
  "platform": "WhirlpoolSixthSense",
  "name": "Whirlpool Sixth Sense",
  "username": "you@example.com",
  "password": "YOUR_APP_PASSWORD",
  "brand": "Whirlpool",
  "region": "EU",
  "enablePush": true,
  "exposeExtraControls": true,
  "pollInterval": 60,
  "discoveryInterval": 900,
  "requestTimeout": 10,
  "devices": [],
  "debug": false
}
```

| Setting | Default | Meaning |
| --- | --- | --- |
| `username`, `password` | Required | Same email address and password as the manufacturer app |
| `brand` | `Whirlpool` | `Whirlpool`, `Maytag`, or `KitchenAid`; select the **app** brand |
| `region` | `EU` | `EU` or `US`; must match the account |
| `enablePush` | `true` | Receive live cloud events over WebSocket/STOMP; polling also runs |
| `exposeExtraControls` | `true` | Expose supported Eco, Quiet, Turbo, and Display switches |
| `pollInterval` | `60` | Status refresh interval in seconds; 30–3600 |
| `discoveryInterval` | `900` | Refresh the appliance list in seconds; 300–86400 |
| `requestTimeout` | `10` | Cloud request timeout in seconds; 5–30 |
| `devices` | `[]` | Optional names, exclusions, and AC temperature limits by SAID |
| `debug` | `false` | Additional connection messages; tokens, passwords, and response bodies are never logged |

### Rename or exclude an appliance

Find its SAID on the appliance label or in the manufacturer app's appliance
settings, then add a device override:

```json
"devices": [
  {
    "said": "YOUR_AC_SAID",
    "name": "Bedroom AC",
    "minTemperature": 16,
    "maxTemperature": 30
  },
  {
    "said": "ANOTHER_APPLIANCE_SAID",
    "exclude": true
  }
]
```

The per-device editor starts with no rows. Use its Add button only when you
want to rename, exclude, or override limits for a specific appliance. Saving a
new configuration does not insert a row with only default settings.

Leave `devices` empty (`[]`) for automatic discovery. An unused settings row
without a SAID is ignored with a warning, so it cannot block account login or
appliance discovery. Other valid rows still apply.

Restart Homebridge after changing settings. Exclusions remove cached
accessories even when the cloud is unreachable. Names keep the same accessory
identity; a name already customized in Apple Home may still need to be changed
there. Temperature overrides change HomeKit limits only; they do not expand
what the physical appliance supports. Set limits supported by your model.

### Air-conditioner behavior

Air conditioners use the native HomeKit air-conditioner category and a primary
HeaterCooler service. Fan-only controls are linked to that climate service.
Cached ACs are corrected without changing their accessory UUIDs.

- HomeKit **Auto** sends the SDK's Sixth Sense mode (`Cavity_OpSetMode=4`).
- Heat and Cool use the same physical setpoint. Both HomeKit threshold
  characteristics reflect that one value; they are not independent settings.
- **Fan Only** is a separate native fan service. Turning it on selects fan
  mode; activating the climate service resumes the last heat/cool/auto mode.
- Fan percentages map to the device's discrete values: **0 = automatic**,
  **1–33 = low**, **34–66 = medium**, **67–100 = high**. Use the power control
  to turn the appliance off. The fan service also exposes Auto/Manual.
- Fan speed and swing affect the same appliance from either service.
- Current temperature is divided by ten, as in the original SDK. Commands
  multiply the target temperature by ten and use whole-degree steps.
- Current heating/cooling activity is inferred from the reported operating
  mode and current versus target temperature. The source does not provide
  a separate compressor-running attribute.

## Connection and recovery

The plugin discovers owned and shared appliances. It preserves the supplied
integration's handling of the optional shared-appliance endpoint: HTTP 404
does not stop successful owned discovery. A failed owned request is not
treated as successful just because the shared list is empty. Cached shared
accessories are retained when their discovery endpoint is unavailable;
incomplete discovery never removes appliances from an unverified route.

Status polling continues if push is unavailable. WebSocket reconnection uses
backoff. Cloud calls are limited to three concurrent status requests; duplicate
refreshes are combined, and commands to each appliance run in order. HomeKit
reads use the local cache and never wait for cloud requests. Offline devices
return a HomeKit communication error rather than fabricated measurements.

Access tokens refresh automatically. An account lock or rejected credentials
stop automatic authentication retries. Fix the account in the manufacturer
app, verify plugin settings, and restart this plugin to retry.

Refresh tokens are saved in a private, account-specific session file under the
Homebridge storage directory (`homebridge-whirlpool-sixth-sense/`), with file
permissions `0600`. That file contains tokens, not your password. Your app
password remains in Homebridge's usual configuration file. No credentials or
session tokens are written into accessory context. No account credentials or
session tokens are included in the distributed files. The public mobile-app
client identifiers used by the original SDK are included with their license.

## Troubleshooting

**Version 1.0.1 finds the appliance but reports missing associated plugin or
duplicate UUID:** Install version 1.0.2 and restart Homebridge. This fixes the
registration order. Existing accessory identity is preserved.

**Version 1.0.0 stops with "Each device override needs its SAID":** Remove the
unused row from Per-device settings, or set `"devices": []` in this platform
configuration, then restart Homebridge. Version 1.0.1 fixes this by ignoring
rows without a SAID.

**No appliances:** Check the account, region, and app brand; confirm the devices
work in the app. This version detects air conditioners by a data model
containing `airconditioner`, and laundry appliances by `washer` or `dryer`,
matching the source SDK. Enable debug logging to identify unsupported models.

**No response:** Check that the appliance is online in the app. Review the
Homebridge log for network or authentication errors. Commands must also be
accepted by the appliance's current mode and local remote-control settings.

**Shared endpoint 404:** This is optional. Owned devices continue working.

**A switch is missing:** Extra controls only appear if the appliance reports
their corresponding attributes and `exposeExtraControls` is enabled.

**Unusual laundry display:** Apple Home's contact/occupancy wording follows
the mappings above. Detailed strings and timers need a compatible third-party
HomeKit app. No battery or environmental readings are repurposed as laundry data.

## Development and publication

The source archive includes JavaScript source, tests, a lockfile, configuration
examples, a Homebridge UI schema, licenses, and GitHub Actions CI. There is no
TypeScript compilation step. Runtime dependency: `ws`; Homebridge is supplied
by the host installation.

```bash
npm ci
npm run check
npm test
npm pack
```

Tests use protocol fixtures, actual HAP services and Homebridge cache handlers,
the real settings form renderer, and a local WebSocket server. They do not need cloud credentials or operate live appliances. A live
account/appliance check is still required after installing this first release.

The package metadata is prepared for:

```text
https://github.com/Kosztyk/homebridge-whirlpool-sixth-sense
```

Create that repository and push the source folder contents. Then, from the
source directory, sign in as the npm account that will own the package:

```bash
npm login
npm publish --access public
```

The `author` field is Kosztyk. npm ownership comes from the publishing account,
so changing `author` alone does not change the npm owner. Repository creation,
pushing, and npm publication are not performed by the supplied archives.

## Credits and license

MIT © 2026 Kosztyk. Whirlpool protocol and attribute mappings are derived from
Abílio Costa's MIT-licensed `whirlpool-sixth-sense` library; its copyright and
license are retained in `THIRD_PARTY_NOTICES.md`. The supplied Home Assistant
custom integration provided the appliance scope, extra sensor behavior, and
shared-discovery compatibility behavior.

Unofficial community plugin; not affiliated with Whirlpool Corporation.
