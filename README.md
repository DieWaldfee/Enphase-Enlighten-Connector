# ioBroker Enphase Battery Control

Control Enphase battery storage systems via the Enphase Enlighten Cloud API — directly from ioBroker, without a local Envoy connection.

> **Note:** This script was developed with the assistance of AI (Claude by Anthropic).

---

## Credits & Inspiration

This project is based on and inspired by the Home Assistant integration
[chinedu40/hacs_enphase_envoy_cloud](https://github.com/chinedu40/hacs_enphase_envoy_cloud).

The session-based authentication against `enlighten.enphaseenergy.com` was ported from that project and extended with additional features for use in the ioBroker JavaScript adapter.

---

## Features

| Feature | Description |
|---|---|
| **Login** | Session-based login with email/password, JWT token caching (file + ioBroker states) |
| **Token management** | Automatic token validation, daily renewal at 3 AM, persistence across restarts |
| **Restrict battery discharge** | Toggle the RBD (Restrict Battery Discharge) switch via cloud API |
| **Charge from grid** | Enable/disable charging from the electrical grid |
| **Read discharge schedules** | Read RBD schedules from Enphase Cloud and store in ioBroker states |
| **Read charge schedules** | Read CFG schedules (Charge from Grid) from Enphase Cloud |
| **Restore schedules** | Re-apply stored schedules to the cloud after they are cleared by the API |
| **Delete schedules** | Remove all discharge or charge schedules from the cloud (soft-delete) |
| **Auto-restore** | After enabling RBD, deleted schedules are automatically restored after a configurable delay |
| **MQTT support** | Transparent MQTT path for systems with `supportsMqtt: true` |

---

## Requirements

- **ioBroker** with the **JavaScript adapter** (`iobroker.javascript`) installed
- **Node.js** ≥ 14 (included with ioBroker)
- An Enphase account at [enlighten.enphaseenergy.com](https://enlighten.enphaseenergy.com)

---

## Installation

### 1. Install required npm packages

```bash
cd /opt/iobroker
npm install node-fetch@2
```

> **Important:** Install `node-fetch` in **version 2** (CommonJS compatible).
> Version 3 uses ESM and cannot be loaded with `require()`.

For systems with MQTT support (`supportsMqtt: true`), also install:

```bash
cd /opt/iobroker
npm install mqtt
```

The `mqtt` package is optional — if not installed, the REST path is used instead.

### 2. Add the script to ioBroker

1. Open ioBroker Admin → **Scripts**
2. Create a new JavaScript script
3. Paste the contents of `enphase_enlighten_connector.js`
4. **Save** (do not start yet)

### 3. Configure credentials

After saving, the script creates all required data points automatically.
Then enter your credentials:

| Data point | Value |
|---|---|
| `0_userdata.0.enphase.battery.config.email` | Your Enphase account email |
| `0_userdata.0.enphase.battery.config.password` | Your Enphase account password |

### 4. Start the script

After entering your credentials, start the script. On first start it will:
- Perform a full login
- Read the current battery status from the cloud
- Read all schedules and save them to ioBroker states

---

## Data Points

All data points are created under `0_userdata.0.enphase.battery.*`.

### Configuration (`config.*`)

| Data point | Default | Description |
|---|---|---|
| `config.email` | – | Enphase account email |
| `config.password` | – | Enphase account password |
| `config.max_discharge_schedules` | 1 | Max number of discharge schedule slots in ioBroker |
| `config.max_charge_schedules` | 1 | Max number of charge schedule slots in ioBroker |
| `config.restore_delay_ms` | 15000 | Delay (ms) before auto-restoring schedules after RBD activation |

> After changing `max_discharge_schedules` or `max_charge_schedules`, restart the script to create the additional data points.

### Control (`control.*`)

| Data point | Type | Description |
|---|---|---|
| `control.battery_discharge_restrict` | boolean (switch) | Toggle RBD: restrict battery discharge |
| `control.battery_charge_from_grid_enable` | boolean (switch) | Enable/disable charging from the grid |
| `control.read_battery_status` | boolean (button) | Manually refresh battery status from cloud |
| `control.read_charge_from_grid_status` | boolean (button) | Manually refresh charge-from-grid status |
| `control.read_discharge_schedules` | boolean (button) | Re-read discharge schedules from cloud |
| `control.restore_discharge_schedules` | boolean (button) | Restore discharge schedules from stored ioBroker data |
| `control.delete_discharge_schedules` | boolean (button) | Delete all discharge schedules in the cloud |
| `control.read_charge_schedules` | boolean (button) | Re-read charge schedules from cloud |
| `control.restore_charge_schedules` | boolean (button) | Restore charge schedules from stored ioBroker data |
| `control.delete_charge_schedules` | boolean (button) | Delete all charge schedules in the cloud |

### Status (`status.*`)

| Data point | Type | Description |
|---|---|---|
| `status.battery_discharge_cloud` | boolean | Current RBD status from cloud |
| `status.charge_from_grid_cloud` | boolean | Current charge-from-grid status from cloud |
| `status.battery_grid_mode` | string | Current `batteryGridMode` value |
| `status.jwt_token` | string | Current JWT token (read-only) |
| `status.jwt_expires` | string | JWT expiry time (ISO 8601) |
| `status.xsrf_token` | string | XSRF token (read-only) |
| `status.user_id` | string | Enphase user ID |
| `status.battery_id` | string | Enphase site/battery ID |
| `status.last_login` | string | Timestamp of last successful login |

### Discharge Schedules (`schedules.discharge.*`)

| Data point | Description |
|---|---|
| `schedules.discharge.count` | Number of stored discharge schedules |
| `schedules.discharge.raw_json` | All schedules as a JSON array |
| `schedules.discharge.0_startTime` | Start time of slot 0 (HH:MM) |
| `schedules.discharge.0_endTime` | End time of slot 0 (HH:MM) |
| `schedules.discharge.0_timezone` | Timezone of slot 0 |
| `schedules.discharge.0_days` | Active days of slot 0 (JSON array, 1=Mon…7=Sun) |
| `schedules.discharge.0_enabled` | Whether slot 0 is active |
| `schedules.discharge.0_json` | Full schedule object for slot 0 |

Slots `1_*`, `2_*`, … are created according to `config.max_discharge_schedules`.

### Charge Schedules (`schedules.charge.*`)

Same structure as `schedules.discharge.*`, with one additional field per slot:

| Data point | Description |
|---|---|
| `schedules.charge.0_limit` | Charge limit in % (0–100), e.g. `100` = fully charge |

---

## Schedules — Important Notes

> **Recommendation:** Create and modify schedules directly on the Enphase Enlighten website at
> [enlighten.enphaseenergy.com](https://enlighten.enphaseenergy.com).
> The web interface is more convenient than editing raw ioBroker data points.

This script is primarily designed to **read** existing schedules into ioBroker and **restore** them when needed — not to create them from scratch.

### Why restore is needed

The Enphase Cloud API sometimes silently drops schedules when certain settings are changed — for example, when the RBD (Restrict Battery Discharge) switch is activated. This is an API-side behaviour that cannot be prevented from the client.

To work around this, the script:
1. Reads and caches all schedules in ioBroker states (`raw_json`)
2. After enabling RBD, waits for `config.restore_delay_ms` (default: 15 s)
3. Deletes all remaining cloud schedules (soft-delete via `PUT isDeleted: true`)
4. Re-creates all cached schedules via `POST`

This ensures schedules survive toggling the RBD switch. Use `control.restore_discharge_schedules` or `control.restore_charge_schedules` to trigger restoration manually at any time.

---

## Token Persistence

Tokens are stored in two locations:

1. **File cache:** `/opt/iobroker/iobroker-data/enphase_battery_auth.json`
   (path can be changed via `CACHE_FILE` in the script)
2. **ioBroker states:** `status.jwt_token`, `status.xsrf_token`, etc.

On startup both sources are loaded; the file cache takes precedence. A new login only occurs when the token has expired or is missing.

---

## Debug Level

Adjust the log verbosity inside the script:

```javascript
let debug = 1; // 0=minimal  1=info  2=extended  3=full
```

---

## Known Limitations

- The script uses Enphase's internal, undocumented cloud API. Changes on Enphase's side may break functionality at any time.
- MQTT support requires the `mqtt` npm package and is only relevant for systems where `supportsMqtt: true`.
- The exact structure of charge schedules (`schedules.charge.*`) may vary depending on the system configuration — check the logs to inspect the raw API response.

---

## AI Assistance

This script was developed with the help of **Claude (Anthropic)**.
AI assisted with porting the original Python authentication logic to JavaScript, debugging, and implementing extended features (schedules, MQTT, token management, restore logic).

---

## License
GPL-3.0 license
