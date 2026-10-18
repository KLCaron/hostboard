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

Historical ranges are 15 minutes, 1 hour, 6 hours and 24 hours. CPU, memory, network, disk I/O and load charts contain up to 180 averaged samples. Retention and available history depend on the Agent.

Live metrics refresh every 10 seconds; history refreshes every 30 seconds. The backend caches snapshots for 8 seconds, history for 25 seconds and metadata for one minute. Requests use timeouts and deduplication.

Missing metrics remain empty. Chart gaps are not filled. Hosts without fresh CPU samples are marked stale; failed Agent connections are marked offline. Browser data becomes stale after 30 seconds without a successful refresh. Fleet totals exclude offline and stale hosts, so check host coverage when reading them.

The integration uses `/api/v3/nodes`, `/api/v3/contexts`, `/api/v3/data` and `/api/v3/alerts`. The compatibility `/host/{machine-guid}/api/v1/charts` endpoint supplies per-instance filesystem, container and cgroup labels. See the [Netdata API documentation](https://learn.netdata.cloud/docs/developer-and-contributor-corner/rest-api).

## Development and checks

Requires Node.js 24 or later and access to configured Netdata Agents.

```sh
npm ci
npm run dev      # Vite on 5173; API on loopback 3001
npm test         # Normalization, node isolation, caching and failure handling
npm run build    # TypeScript checks and production frontend/backend
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

The MVP does not provide alert acknowledgement, notification delivery, container control, custom metric exploration or historical backfill. Missing collectors and unmatched container labels result in unavailable values. No Netdata Cloud account is required.
