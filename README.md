# Hostboard

Hostboard is a self-hosted dashboard for Netdata Agents. It displays metrics, historical charts, container resources and alerts for multiple hosts.

The frontend uses React, TypeScript, Tailwind CSS and Recharts. A small TypeScript backend retrieves and normalizes Agent data. Browsers connect only to Hostboard; collection and historical storage remain with Netdata.

## Run with Docker Compose

Requires Linux, Docker Compose, and Netdata Agents with v3 API support.

```sh
cp config/hosts.example.json config/hosts.json
cp .env.example .env
# Configure the Agent connections and listening address.
docker compose up -d --build
```

The default URL is `http://127.0.0.1:8088`. Set `HOSTBOARD_BIND` to a private LAN or VPN address to allow other devices to connect, and `HOSTBOARD_PORT` to change the port. Wildcard and public listener addresses are rejected.

Hostboard has no built-in authentication. Keep it on a trusted network or behind an authenticated reverse proxy that protects all paths, including `/api/*`. If a firewall is enabled, allow access only from the intended network. Keep Netdata's HTTP APIs private as well.

The container runs as a non-root user with a read-only filesystem, no capabilities and bounded resources. It does not mount the Docker socket. Compose uses Linux host networking to reach a loopback-only Agent.

## Configure hosts

Edit the ignored `config/hosts.json`. Each entry requires:

| Field | Description |
| --- | --- |
| `id` | Unique identifier used in Hostboard API paths. |
| `name` | Display name. |
| `url` | HTTP(S) origin of a reachable Netdata Agent. |
| `node` | Exact hostname, machine GUID or node UUID returned by that Agent's `/api/v3/nodes` endpoint. |
| `tokenEnv` | Optional name of an environment variable containing an Agent bearer token. |

See [config/hosts.example.json](config/hosts.example.json) for a complete example.

Hosts can use separate Agent origins or share a Netdata parent that receives their streams. Every data query selects and verifies one node. Wildcard node selectors and URLs containing credentials are rejected.

To add a host, configure its Agent and private connectivity, add a configuration entry, then restart Hostboard:

```sh
docker compose up -d --force-recreate
```

When using Netdata streaming, configure the parent to accept the new child and permit its source through any streaming firewall rules. The node must appear in the configured Agent's `/api/v3/nodes` response before Hostboard can query it.

The configuration file must be readable by container uid 1000. Store tokens in environment variables and explicitly pass those variables to the container if using `tokenEnv`. Do not put credentials in URLs or tracked files.

## Metrics and history

- Host status, uptime, CPU utilization and 1/5/15-minute load.
- RAM utilization, excluding cache and buffers from used memory.
- Persistent filesystem capacity and usage. Filesystems are listed independently; bind mounts may overlap.
- Network throughput and disk I/O in binary byte rates. Host aggregates follow the Agent's configuration.
- Docker state and health, with CPU and resident memory joined from cgroup labels. Container CPU usage is measured per core: 100% equals one core.
- Reported temperature sensors, with the warmest sensor in the host summary.
- Active Netdata warning and critical alert summaries, including affected instance counts.

Overview ranges are 15 minutes, 1 hour, 6 hours and 24 hours. CPU sparklines show bucket peaks derived from minimum idle, avoiding sums of unrelated component peaks. Other overview sparklines show averages. Open a host or alert for detailed investigation.

Detailed charts request at most 240 buckets per aggregation (minimum, average, maximum), per selected chart. CPU busy is derived as `100 - idle`, with extrema inverted. Other metrics show each dimension separately; directional network/disk/swap rates use positive magnitudes. Netdata performs time aggregation using its storage tiers. Summing component maxima would overstate a simultaneous total and is deliberately avoided. A displayed average is the mean of returned bucket averages, not a sample-weighted incident statistic.

Use presets, a custom past window (30 seconds–31 days), zoom buttons, pan buttons, or the chart brush followed by **Zoom to brushed selection**. Zooming and panning pause the chart. **Resume live** returns to a moving preset window. Current host snapshots continue updating while an investigation is paused. Range, selected metric and container sorting preferences are saved in browser storage. Direct host links use `#host=<id>`.

Each detailed chart reports available retention and returned bucket resolution. Retention varies by metric, node and tier. Missing samples remain gaps; spikes shorter than collection or retained resolution cannot be recovered. Removed containers or charts may no longer have discoverable labels, even if some data remains in Netdata.

Live metrics refresh every 10 seconds; history refreshes every 30 seconds. The backend caches snapshots for 8 seconds, history for 25 seconds and metadata for one minute. Requests use timeouts and deduplication.

Missing metrics remain empty. Chart gaps are not filled. Hosts without fresh CPU samples are marked stale; failed Agent connections are marked offline. Browser data becomes stale after 30 seconds without a successful refresh. Fleet totals exclude offline and stale hosts, so check host coverage when reading them.

The integration uses `/api/v3/nodes`, `/api/v3/contexts`, `/api/v3/data`, `/api/v3/alerts`, `/api/v3/alert_transitions` and `/api/v3/alert_config`. The compatibility `/host/{machine-guid}/api/v1/charts` endpoint supplies per-instance filesystem, container and cgroup labels. See the [Netdata API documentation](https://learn.netdata.cloud/docs/developer-and-contributor-corner/rest-api).

## Development and checks

Requires Node.js 24 or later and access to configured Netdata Agents.

```sh
npm ci
npm run dev      # Vite on 5173; API on loopback 3001
npm test         # Normalization, node isolation, caching and failure handling
npm run build    # TypeScript checks and production frontend/backend
npx playwright install firefox
npm run test:browser # Firefox desktop and mobile; requires running app + real Agents
npm start        # Serve the production build
```

To check a running instance against its configured Agents:

```sh
node scripts/check-live.mjs http://127.0.0.1:8088
```

This acceptance check expects all configured hosts to be online with the core metrics available. It checks live data, all four historical ranges, HTTP assets, security headers and API input validation. Optional collectors may be unavailable even when the dashboard is otherwise usable.

## Update and roll back

Keep `.env` and `config/hosts.json` outside version control. To update a source checkout:

```sh
git pull
docker compose up -d --build
```

To roll back, check out the previous release and rebuild the Compose service. Preserve the local environment and host configuration. Hostboard has no database or migrations; Netdata retains the monitoring history independently.

## Current limitations

Hostboard does not provide alert acknowledgement, container control or historical backfill. Missing collectors and unmatched container labels result in unavailable values. No Netdata Cloud account is required.

## Investigation and diagnostics

The Alerts view shows individual active warning/critical instances and recently resolved incidents from up to 200 transitions over the last seven days per host (50 resolved rows maximum). Netdata may retain less history. Thresholds are displayed as the original warning/critical expressions, including dynamic thresholds; unavailable expressions are labelled. Active start time defaults to the last state change and follows retained warning/critical transitions when possible. Resolved duration uses Netdata's raised duration. Removed or uninitialized states are not presented as successful resolutions. Click an incident for its resource chart and a window around the event. Alert calculations can use rolling windows or expressions that differ from raw chart dimensions.

Host details contain a Diagnostics tab for CPU load/PSI, memory some/full PSI, swap capacity/activity, OOM kill rate, disk throughput/latency, I/O PSI and inode counts. PSI is stalled task time, not utilization. OOM is a rate, not a cumulative kill count. Device layers and filesystem mounts can overlap. Temperatures are separated into CPU, storage and other sensors based on Agent labels; unidentified sensors remain in the other group.

Container tables sort by name, CPU or resident memory. Select a container for CPU, memory, network and disk history where collected. A collapsed Services section associates containers with their hosts and distinguishes process state from configured Docker health checks. Application availability remains explicitly unknown unless independently checked. No Docker socket is mounted. The service presentation can later accept independent check results without changing Netdata collection.

Detailed data loads only when needed. Investigation responses are cached for 25 seconds, concurrent identical queries are deduplicated, and historical cache entries are bounded. All metric IDs must exist in the configured node's catalog. Browser requests never select arbitrary upstream URLs.

## Notifications and independent availability

Netdata evaluates alerts independently of Hostboard and continues when the dashboard is closed. Notification delivery requires a working Agent notification method and destination, or separately verified Netdata Cloud notification routing. An active alert, an `EXEC_RUN` flag, or a present sendmail binary does not prove a recipient received a message. Inspect `/api/v1/info` notification methods, the effective `health_alarm_notify.conf`, transport configuration and delivery logs. Configure recipients and credentials privately, then explicitly test delivery after recipient approval. Hostboard does not duplicate Netdata's alert engine or send external notifications.

An optional independent watchdog is provided in `scripts/watchdog.py` with systemd units under `deploy/`. Install it on a different machine with Python 3 and private access to Hostboard. Copy the script to `/usr/local/lib/hostboard-watchdog.py`, copy the units to `/etc/systemd/system/`, and create `/etc/hostboard-watchdog.env` using the example. Enable with `systemctl enable --now hostboard-watchdog.timer` after `systemctl daemon-reload`.

The watchdog checks Hostboard HTTP health, fresh fleet output and the hosting server's Agent status every minute. It writes `/var/lib/hostboard-watchdog/status.json` and systemd journal entries; failures exit nonzero. It does not verify public authentication or deliver notifications. View results with `journalctl -u hostboard-watchdog.service` and `systemctl status hostboard-watchdog.timer`. Remove with `systemctl disable --now hostboard-watchdog.timer`, then remove its units, script and environment file. External delivery can later use approved Netdata notification destinations or a systemd failure handler.

Browser tests use real Agent data and inject request failures to exercise error states. Alert browser checks investigate available active and resolved incidents, or verify the corresponding empty states. Set `HOSTBOARD_TEST_URL` to verify another running instance. Tests do not bundle demonstration metrics.

Release helpers are included as `scripts/deploy.sh` and `scripts/rollback.sh`. Deployment validates SSH host identity, runs backend tests and the production build, retains tagged Docker images and previous release source, and restores the previous image if startup fails. Browser acceptance checks are a separate pre/post-deployment step. Only the Hostboard Compose service is recreated; Netdata storage is untouched. The runtime image includes the AGPL-3.0 license.
