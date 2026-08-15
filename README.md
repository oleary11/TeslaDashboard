# Tesla Dashboard

A self-hosted Tesla Fleet API dashboard and TeslaCam studio. It collects vehicle telemetry, builds drive and charging history, analyzes battery health and commutes, and provides a fast browser-based dashcam viewer/editor.

## Features

### Vehicle dashboard

- Live charge, range, climate, location, speed, and vehicle status
- Drive history with route maps, efficiency, destinations, and speed analysis
- Charging sessions, charging summaries, and estimated gasoline savings
- Battery range and degradation history
- Commute detection and departure-time analysis
- Stop clustering and dwell-time analysis
- Multiple local dashboard users with isolated Tesla accounts

### TeslaCam Studio

- Import a complete TeslaCam folder from the browser or copy it with SCP
- Index `SavedClips`, `SentryClips`, and optional `RecentClips`
- Hide routine footage by default and identify events using Tesla's `event.json`
- Jump directly to Tesla's event timestamp
- Start on the camera identified by Tesla as the triggering camera
- Switch between front, rear, left-repeater, and right-repeater views
- Lazy-loaded event thumbnails and HTTP byte-range video streaming
- Full-screen timeline editor with trim, split, reorder, removal, and crop presets
- Server-rendered MP4 exports through FFmpeg; source recordings remain unchanged
- Two-step deletion of unwanted events, including every camera and context file in the event folder

## Architecture

The Docker Compose stack contains:

| Service | Purpose |
| --- | --- |
| `frontend` | React/Vite application served by Nginx on port `8094` |
| `backend` | FastAPI API, scheduler, SQLite storage, TeslaCam streaming, and FFmpeg editing |
| `fleet-telemetry` | Tesla's Fleet Telemetry collector exposed on TCP `4443` |
| `vehicle-command` | Tesla's signed vehicle-command proxy |
| `mosquitto` | Internal MQTT transport for telemetry |
| `osrm` | Local route matching for recorded drives |

Persistent state lives under `data/`. Keep this directory private and back it up securely: it contains the SQLite database, OAuth tokens, vehicle keys, and uploaded dashcam footage.

## Requirements

- A Linux server with Docker Engine and Docker Compose v2
- A public HTTPS hostname for the dashboard
- A separate public hostname and forwarded TCP port for Fleet Telemetry
- A Tesla developer application and a Tesla account with an eligible vehicle
- TLS certificates for the telemetry hostname
- Approximately 1.5 GB of memory for OSRM, plus space for regional map data
- Substantial storage if retaining TeslaCam footage

This application is an independent project and is not affiliated with or endorsed by Tesla, Inc. Tesla Fleet API availability, pricing, scopes, and requirements can change.

## 1. Clone and configure

```shell
git clone https://github.com/oleary11/TeslaDashboard.git
cd TeslaDashboard
cp .env.example .env
cp telemetry-config.example.json telemetry-config.json
```

Generate a strong JWT secret:

```shell
openssl rand -hex 32
```

Edit `.env` and set at minimum:

```dotenv
ADMIN_USERNAME=admin
ADMIN_PASSWORD=a-long-unique-dashboard-password
JWT_SECRET=the-generated-secret
TESLA_CLIENT_ID=your-tesla-client-id
TESLA_CLIENT_SECRET=your-tesla-client-secret
TESLA_REDIRECT_URI=https://tesla.example.com/api/auth/callback
TELEMETRY_HOST=telemetry.example.com
TELEMETRY_PORT=4443
LETSENCRYPT_PATH=/absolute/path/to/your/certificate-store
```

`ADMIN_PASSWORD` must contain at least 12 characters on a new installation. If `JWT_SECRET` is omitted, the backend creates a private random secret at `data/jwt_secret`; explicitly setting it makes recovery and multi-instance deployments easier.

Optional variables include home/work coordinates for commute detection, an EIA API key for fuel-price comparisons, `DASHCAM_DIRECT_USER_ID` for SCP/rsync imports, and `DASHCAM_MAX_STORAGE_GB`/`DASHCAM_PROTECT_SENTRY` for TeslaCam retention. See [`.env.example`](.env.example) for the complete list.

## 2. Create a Tesla developer application

1. Sign in at [developer.tesla.com](https://developer.tesla.com/).
2. Create a web application.
3. Add the exact redirect URI configured as `TESLA_REDIRECT_URI`.
4. Request the scopes used by the application:
   - `openid`
   - `offline_access`
   - `vehicle_device_data`
   - `vehicle_location`
   - `vehicle_cmds`
5. Put the resulting client ID and client secret in `.env`.

Tesla requires the application's public EC key at:

```text
https://tesla.example.com/.well-known/appspecific/com.tesla.3p.public-key.pem
```

Your reverse proxy must route both `/.well-known/` and `/api/` to the dashboard frontend. The included Nginx container forwards those paths internally to FastAPI.

## 3. Configure Fleet Telemetry

Create DNS for the telemetry hostname and forward public TCP port `4443` to this stack. Edit `telemetry-config.json`:

- Set `server_name` to the public telemetry hostname.
- Set `tls.server_cert` and `tls.server_key` to paths visible inside `/letsencrypt`.
- Set `LETSENCRYPT_PATH` to the host directory mounted at `/letsencrypt`.

The certificate must be valid for the telemetry hostname and the port must be reachable by Tesla's servers. The dashboard configures the vehicle after OAuth completes.

## 4. Prepare OSRM map data

The repository intentionally excludes regional map files because they are large. Download the desired `.osm.pbf` extract from a provider such as Geofabrik, then preprocess it with OSRM's car profile. Place the resulting `.osrm` files in `osrm-data/`.

The included [`osrm-entrypoint.sh`](osrm-entrypoint.sh) discovers the `.osrm` dataset and starts the routing service. Use a region covering every area in which route matching is expected.

If route matching is not needed initially, the dashboard can run while OSRM is unavailable, but mapped drive reconstruction will fail until data is installed.

## 5. Start the application

```shell
docker compose up -d --build
docker compose ps
```

Open `http://server-address:8094` or the HTTPS hostname configured in your reverse proxy. Sign in with `ADMIN_USERNAME` and `ADMIN_PASSWORD`, then connect the Tesla account from the Profile page.

For internet exposure, terminate HTTPS at a trusted reverse proxy and do not expose the backend, MQTT, OSRM, or vehicle-command services directly. Only the dashboard HTTPS endpoint and Fleet Telemetry TCP port need public ingress.

## TeslaCam imports

### Browser import

Open **Dashcam**, select **Import TeslaCam**, and choose the `TeslaCam` directory on the USB drive. Files upload into the authenticated user's private library under `data/dashcam/<user-id>/`.
Files already present at the same relative path with the same byte size are skipped before upload, including files previously copied by SCP, so selecting the same folder again only transfers new or changed clips.

### SCP import

For the user configured by `DASHCAM_DIRECT_USER_ID`, copy Tesla's folders directly into `data/dashcam/`:

```shell
scp -O -r SavedClips server:/path/to/TeslaDashboard/data/dashcam/
scp -O -r SentryClips server:/path/to/TeslaDashboard/data/dashcam/
```

Copying `RecentClips` is optional and can consume considerable space because it contains Tesla's rolling routine-driving buffer. Direct imports are indexed while files remain in their original Tesla folder structure.

### Automatic import from a teslausb Pi

A Raspberry Pi Zero 2 W running [teslausb](https://github.com/marcone/teslausb) can present itself as the car's USB dashcam drive and automatically push footage to this server over Wi-Fi whenever it's in range — no manual SCP or browser import needed.

**1. Build the Pi.** Flash teslausb per its own instructions (CanaKit Pi Zero 2 W + a case + the micro USB cable to the Tesla's front USB port). Give it a large enough microSD/USB storage for a buffer of footage between wifi syncs.

**2. Wi-Fi.** teslausb's `wifi.conf` supports multiple networks; it connects to whichever is in range and only starts archiving once it sees a wifi network matching `archiveserver` in its config (so it won't try to sync over a phone hotspot, etc.). Add both home and work SSIDs.

- **Home wifi** works normally with a PSK.
- **Work wifi with a captive portal login page cannot be scripted through `wpa_supplicant` alone** — the Pi has no browser to click through the login screen, so it will associate but not get real internet/LAN access. The reliable fix is asking IT for a MAC-based bypass/device registration for the Pi's wifi MAC address (`cat /sys/class/net/wlan0/address` after first boot) so it skips the portal entirely. Without that, treat work wifi as unavailable to teslausb and rely on home wifi for archiving.
- Whether the car (and Pi) will even be in range of either network while parked is worth confirming before relying on this — if not, archiving only happens when you're home.

**3. Point archiving at this server.** teslausb's `archiveconfig.sh` should use the `rsync` archive method:

```shell
archive_host_name=<this-server's-hostname-or-LAN-IP>
archive_username=teslacam
archive_dir=/
```

Run `sudo dashcam-ingest/setup-teslacam-user.sh` once on this server first — it creates a `teslacam` Linux account that can *only* run `rsync` and *only* write inside `data/dashcam/{SavedClips,SentryClips,RecentClips}` (enforced with `rrsync` and a forced SSH `command=` in `authorized_keys`, plus `no-pty`/`no-port-forwarding`/`no-X11-forwarding`/`no-agent-forwarding`). It also prints the exact `archive_host_name`/`archive_username` values to use.

The account's login shell must be a real shell (the script sets `/bin/sh`), not `nologin`/`false` — OpenSSH forced commands run as `<shell> -c "<command>"`, so a non-executing shell blocks the forced `rrsync` command too, not just interactive logins. The forced-command + `rrsync` jail is what actually constrains the account; the shell itself grants no access beyond what SSH lets through.

Preferably, generate the SSH keypair *on the Pi* itself (teslausb's own setup usually offers this) so the private key never leaves the device — then run the setup script with the Pi's public key as an argument: `sudo dashcam-ingest/setup-teslacam-user.sh "ssh-ed25519 AAAA... root@teslausb"`. Otherwise, copy the bundled private key at `dashcam-ingest/teslacam_pi_key` onto the Pi as its archive SSH key — it is gitignored and must never be committed.

The script also grants `teslacam` a traverse-only POSIX ACL (via the `acl` package, installed automatically if missing) on every ancestor directory of `data/dashcam` — needed because `rsync`/`rrsync` must reach that path even if a directory above it (e.g. a private home directory) isn't otherwise world-traversable. This only lets `teslacam` pass through those directories; it can't list or read their contents.

Once installed, verify the whole chain works from the Pi before relying on it:

```shell
ssh -i <the archive private key> teslacam@<archive_host_name> true
```

A working setup exits silently or with an rsync-protocol message; `Permission denied (publickey)` means the key isn't installed/matched, and a Python traceback about a locked/inaccessible directory means the ACL step above didn't reach far enough (rerun the setup script, or check `getfacl` on each ancestor of `data/dashcam`).

Because the Pi writes into the same `SavedClips`/`SentryClips`/`RecentClips` folders as manual SCP, footage it archives is indexed automatically for `DASHCAM_DIRECT_USER_ID` — nothing else to configure on the dashboard side.

### Storage cap and automatic deletion

Dashcam footage can consume a lot of disk space quickly, especially with an always-syncing Pi. Set `DASHCAM_MAX_STORAGE_GB` in `.env` to cap total space used by `data/dashcam`. A background job checks usage every 15 minutes and, if over cap, deletes the oldest events first:

- `RecentClips` (Tesla's rolling routine-driving buffer) are always pruned first.
- `SentryClips` are pruned next, oldest first — unless `DASHCAM_PROTECT_SENTRY=true`, in which case they're kept indefinitely like Saved clips.
- `SavedClips` — footage you or Sentry Mode explicitly marked as "keep" in the car — are **never** auto-deleted, at any cap.

The Dashcam page shows a usage bar against the configured cap when one is set. Deletion always removes a clip's full event folder (every camera angle plus `event.json`/`thumb.png`), matching the manual two-step delete already used in the UI.

```shell
git pull
docker compose up -d --build
```

Database migrations run automatically and preserve existing data. Back up `data/` before significant upgrades.

## Backup and recovery

Stop the backend before taking a filesystem-level SQLite backup, or use SQLite's online backup command. Preserve:

- `data/tesla.db`
- `data/tesla_partner_key.pem`
- `data/jwt_secret` when no `JWT_SECRET` is configured
- `data/dashcam/` if footage must be retained
- `dashcam-ingest/teslacam_pi_key` (the Pi's archive SSH private key), if using automatic teslausb import
- `.env` and `telemetry-config.json` in a secure secrets backup

Never commit these files. They are excluded by `.gitignore` because they contain credentials, precise vehicle/location history, or private video.

## Security notes

- Dashboard endpoints require a signed local user token; administrative endpoints additionally require an admin account.
- Tesla OAuth client secrets stored through the UI are encrypted using the JWT secret.
- Dashcam libraries are isolated per dashboard user. Direct SCP/rsync folders belong only to `DASHCAM_DIRECT_USER_ID`.
- The `teslacam` archive account (if configured) is forced-command SSH restricted to `rsync` inside `data/dashcam` only, with no port/X11/agent forwarding and no pty — it cannot reach any other path or run any other command, even though it has a login shell (required for the forced command to execute at all).
- Video URLs use short-lived in-memory access tokens and support byte-range requests.
- CORS is disabled by default. Set `CORS_ORIGINS` only when a separate trusted frontend origin requires it.
- Use HTTPS, a strong administrator password, firewall rules, and rate limiting at the reverse proxy.
- Treat backups as highly sensitive because the database includes OAuth credentials and location history.

For a vulnerability, avoid opening a public issue containing secrets, VINs, coordinates, tokens, or private footage. Rotate affected Tesla credentials and the JWT secret immediately if exposure occurs.

## Development

Frontend:

```shell
cd frontend
npm install
npm run dev
```

Production frontend check:

```shell
npm run build
```

Backend syntax check:

```shell
python3 -m py_compile backend/main.py
```

## License

MIT. See [`LICENSE`](LICENSE).
