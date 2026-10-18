# Hostboard

Hostboard is a self-hosted dashboard for Netdata Agents. It displays metrics, historical charts, container resources and alerts for multiple hosts.

The frontend uses React, TypeScript, Tailwind CSS and Recharts. A small TypeScript backend retrieves and normalizes Agent data. Browsers connect only to Hostboard; collection and historical storage remain with Netdata.

## Run with Docker Compose

Requires Linux, Docker Compose, and Netdata Agents with v3 API support.

```sh
cp config/hosts.example.json config/hosts.json
printf '{"checks":[]}\n' > config/checks.json
mkdir -m 700 data private
cp .env.example .env
# Configure the Agent connections and listening address.
docker compose up -d --build
```

The default URL is `http://127.0.0.1:8088`. Set `HOSTBOARD_BIND` to a private LAN or VPN address to allow other devices to connect, and `HOSTBOARD_PORT` to change the port. Wildcard and public listener addresses are rejected.

Read-only monitoring remains protected by your trusted network or authenticated reverse proxy. Protect all paths, including `/api/*`. Application administration additionally requires a verified Cloudflare Access JWT and an explicit administrator allowlist, including on direct LAN connections. Missing administrative configuration locks all administrative endpoints. If a firewall is enabled, allow access only from the intended network. Keep Netdata's HTTP APIs private as well.

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

Use presets, a custom past window (30 seconds–31 days), zoom buttons, pan buttons, or drag across the chart/timeline followed by **Zoom to brushed selection**. The selection handles also support dragging and keyboard arrows; selecting pauses live updates. Zooming and panning pause the chart. **Resume live** returns to a moving preset window. Current host snapshots continue updating while an investigation is paused. Range, selected metric and container sorting preferences are saved in browser storage. Direct host links use `#host=<id>`.

Each detailed chart reports available retention and returned bucket resolution. Retention varies by metric, node and tier. Missing samples remain gaps; spikes shorter than collection or retained resolution cannot be recovered. Removed containers or charts may no longer have discoverable labels, even if some data remains in Netdata.

Live metrics refresh every 10 seconds by default (editable to 300 seconds); history refreshes every 30 seconds. The backend caches snapshots for 8 seconds, history for 25 seconds and metadata for one minute. Requests use timeouts and deduplication.

Missing metrics remain empty. Chart gaps are not filled. Hosts without fresh CPU samples are marked stale; failed Agent connections are marked offline. Browser data becomes stale after the greater of 30 seconds or two configured refresh intervals without a successful refresh. Fleet totals exclude offline and stale hosts, so check host coverage when reading them.

The integration uses `/api/v3/nodes`, `/api/v3/contexts`, `/api/v3/data`, `/api/v3/alerts`, `/api/v3/alert_transitions` and `/api/v3/alert_config`. The compatibility `/host/{machine-guid}/api/v1/charts` endpoint supplies per-instance filesystem, container and cgroup labels. See the [Netdata API documentation](https://learn.netdata.cloud/docs/developer-and-contributor-corner/rest-api).

## Configuration management and administrative security

The v0.4 release candidate includes writable Settings, with administration locked until the operator supplies an explicit identity policy. Copy [config/admin.example.json](config/admin.example.json) to ignored `private/admin.json`, readable by container uid 1000, and customize it before restarting Hostboard. Compose mounts the private directory read-only; `HOSTBOARD_ADMIN_CONFIG` can select another deployment-managed path.

| Setting | Owner and persistence |
| --- | --- |
| Refresh interval, temperature units, chart range, landing page, compact Overview | SQLite application defaults; optional browser-local personal overrides |
| HTTP/TCP definitions, enabled/archive state, friendly names, grouping, intervals, timeout, expected statuses, failure thresholds | SQLite; editable by authorized administrators |
| Service notifications, recipient overrides, minimum severity/cooldown, recovery | SQLite; editable by authorized administrators |
| Raw service sample retention | SQLite; 30–365 days, hourly cleanup |
| Incidents and delivery history | SQLite; retained indefinitely; no deletion control |
| Overview order, card sizes/visibility, preferred metrics | Browser-local storage; device/browser-specific |
| Agent connections and authentication, listener, SMTP credentials/default recipients, admin identities, destination policy | Deployment-managed files/environment; never modified by Settings |
| Netdata alert evaluation/metric storage and parent notification hook | Netdata configuration and independent durable queue |
| Watchdog schedule, SMTP credentials, recipients and delivery queue | Independent watchdog host and systemd configuration |

Administrative authorization validates `Cf-Access-Jwt-Assertion` using the configured Cloudflare team’s JWKS, RS256 signature, issuer, application audience, expiry, issued-at, subject and email. Tokens older than 24 hours require reauthentication. Only the explicit email allowlist can access `/api/admin/*`, including configuration reads. Bare email headers, cookies, LAN source addresses and browser claims do not establish administration. No public registration, local password or development bypass exists. Read-only API access continues to depend on network/proxy protection.

Mutations require the exact configured HTTPS `Origin`, JSON content type and `X-Hostboard-Request: 1`; CORS is not enabled. The identity policy must use the exact Access application audience and team issuer. Consult [Cloudflare’s JWT validation documentation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/). Verify an authorized identity through the actual public hostname before considering administrative rollout complete.

Each destination policy entry approves one exact hostname, port and set of literal resolved addresses. Include **every existing check destination** before enabling this policy. Internal and loopback destinations work only when explicitly approved. New hostnames, ports or changed Docker IPs require a deployment policy update and restart. No wildcard networks or unrestricted private-network access is granted by the UI. All DNS answers must be approved; requests connect to a checked address while preserving TLS SNI/Host. Each followed redirect is checked again and must remain in the original origin. Link-local/cloud metadata, unspecified, multicast and IPv4-mapped IPv6 destinations are rejected. New monitoring URLs cannot contain credentials or query strings. Existing environment-sourced authentication remains hidden and cannot move across origins through the UI. TLS verification remains mandatory.

Service configuration tests perform a real bounded probe without recording an incident or sending a notification. They are limited to one per five seconds. Test email performs a real delivery attempt to saved recipients, even if service notifications are disabled, and reports SMTP acceptance or failure without transport secrets. It is limited to one per minute. These limits persist across restarts. SMTP acceptance does not prove inbox receipt. Automated tests use an isolated provider and never send production email.

SQLite schema migrations run before scheduling. The initial ten (or other configured) check IDs are imported unchanged, including deployment-only content/header/watchdog integration settings. Database configuration wins on subsequent starts. Writes use transactions and optimistic revisions to reject stale concurrent edits. In-flight observations from an earlier configuration are discarded; unrelated identities, histories and checks remain intact. Configuration changes are recorded in a local audit table. Deployment scripts preserve existing `.env`, host and bootstrap check files instead of replacing external configuration.

## Customize the Overview

Choose **Customize Overview** to drag card handles, use earlier/later buttons, select standard/wide and natural/tall sizes, or hide widgets. Enable a preferred-metric card to choose a host and a metric discovered on that Agent. Host/service coverage and active issues remain available in the curated health widget. Two optional metric cards keep the Overview bounded; the full investigation remains in Servers. Charts use the first available dimension’s bucket average and name that dimension explicitly.

**Save layout** persists changes in this browser. **Cancel** discards the draft. **Restore default layout** restores the original cards and clears metric choices. Mobile uses a single controlled card column and preserves order rather than desktop coordinates. Move buttons work without dragging. Hidden widgets remain recoverable from the visibility controls. Missing hosts or collectors display unavailable readings rather than invented data.

General → **This browser** saves personal display values; **Application defaults** changes global defaults for browsers without an override. **Use application defaults** removes personal overrides. Clearing site storage resets browser preferences. No multiuser identity database or preference synchronization is introduced.

## Configuration backup and recovery

Back up `data/monitor.sqlite` with SQLite’s backup API, as shown below; it contains application configuration, monitoring history and notification attempts. Protect it like private infrastructure configuration. Also back up deployment-managed files separately. Browser preferences are not in SQLite.

Deployments and rollbacks create consistent snapshots. Reducing raw retention requires explicit confirmation and creates a snapshot under `data/backups/before-retention-*.sqlite` **before** accepting the change. Cleanup can expire only raw observations; incidents/delivery history are never pruned by this setting. Increasing retention cannot recover already expired samples. Backups are not automatically pruned; operators manage disk usage and off-host copies.

To recover a snapshot, stop only Hostboard, take another backup, move the current database and any `-wal`/`-shm` companions into a recovery directory, then place the selected snapshot at the configured database path, owned by uid 1000, and restart. Retain displaced files until verification succeeds. Do not restore a database while the monitor is running.

A pre-v0.4 rollback reads the retained file-based checks and does not understand new application settings. It may retire checks added/disabled since migration, so retain the automatic **before-rollback** SQLite snapshot for returning to v0.4. Never delete shared data or private configuration when pruning release directories. The original v0.3.1 image and its consistent pre-v0.4 database checkpoint should remain available until acceptance is complete.

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

To roll back, check out the previous release and rebuild the Compose service. Preserve the local environment and host configuration. Hostboard service incidents and notification attempts live in `data/monitor.sqlite`; preserve this directory. Netdata retains its own metric history independently. The release helper snapshots SQLite before deployment and shares data between releases. Rolling back to v0.2.2 leaves this database intact but hides v0.3 availability features.

## Current limitations

Hostboard does not provide alert acknowledgement, container control or historical backfill. Missing collectors and unmatched container labels result in unavailable values. No Netdata Cloud account is required.

## Navigation

Hostboard has five primary sections:

- **Overview** answers whether the fleet and services are healthy, with compact service coverage, active issue counts and server summary cards.
- **Servers** contains host performance, diagnostics, containers, sensors and historical metric investigation.
- **Services** groups independent checks into Applications and Infrastructure. Expand a check for freshness, the last retained successful observation, response-time history, availability coverage and incident/host links. Container resources remain a separate collapsed section here.
- **Issues** presents Netdata metric alerts and Hostboard availability incidents together, with Active and History tabs and filters for source, severity, host, service and status. Failed Hostboard notification delivery appears as one active delivery issue while retries continue. Metric thresholds and availability failures remain distinct records because there is no reliable cross-system correlation metadata. Repeated references to the same persistent incident are counted once. Navigation counts include active records only; historical incidents do not inflate them. Coverage warnings identify unavailable monitoring data.
- **Settings** contains General, Services, Notifications, Data & History, and System Status tabs. Personal preferences are available to every viewer; application configuration and private service targets require an authorized administrator. Independent Netdata/watchdog notification settings remain separately managed.

Section links use `#overview`, `#servers`, `#services`, `#issues` and `#settings`. Host (`#host=<id>`) and incident (`#incident=<id>`) bookmarks remain functional. Service links use `#service=<id>`, and metric issue links use `#alert=<host-id>:<encoded-alert-id>`. Issue filters are bookmarkable, for example `#issues?tab=history&type=availability&service=<check-id>`. Legacy `#alerts`, `#incidents`, `/alerts` and `/incidents` open the corresponding Issues view; direct section paths are also supported. Mobile navigation shows all five section labels in a bottom bar.

## Investigation and diagnostics

The Issues view shows individual active warning/critical instances in Active and recently resolved metric alerts in History from up to 200 transitions over the last seven days per host (50 resolved rows maximum). Netdata may retain less history. Thresholds are displayed as the original warning/critical expressions, including dynamic thresholds; unavailable expressions are labelled. Active start time defaults to the last state change and follows retained warning/critical transitions when possible. Resolved duration uses Netdata's raised duration. Removed or uninitialized states are not presented as successful resolutions. Click an incident for its resource chart and a window around the event. Alert calculations can use rolling windows or expressions that differ from raw chart dimensions.

Host details contain a Diagnostics tab for CPU load/PSI, memory some/full PSI, swap capacity/activity, OOM kill rate, disk throughput/latency, I/O PSI and inode counts. PSI is stalled task time, not utilization. OOM is a rate, not a cumulative kill count. Device layers and filesystem mounts can overlap. Temperatures are separated into CPU, storage and other sensors based on Agent labels; unidentified sensors remain in the other group.

Container tables sort by name, CPU or resident memory. Select a container for CPU, memory, network and disk history where collected. The collapsed Container resources section in Services associates containers with their hosts and distinguishes process state from configured Docker health checks. Application availability remains explicitly unknown unless independently checked. No Docker socket is mounted. Configured independent check results appear alongside linked containers without changing Netdata collection.

Detailed data loads only when needed. Investigation responses are cached for 25 seconds, concurrent identical queries are deduplicated, and historical cache entries are bounded. All metric IDs must exist in the configured node's catalog. Browser requests never select arbitrary upstream URLs.

## Service checks and incidents

On first startup, Hostboard imports ignored `config/checks.json` (see [config/checks.example.json](config/checks.example.json)) into SQLite. An empty initial array starts with no checks. Thereafter use Settings → Services; editing the bootstrap file does not overwrite database configuration. New and edited destinations must satisfy deployment-managed monitoring policy. The API never accepts delivery credentials or authentication header environment names. Each check must reference a configured host ID. An optional `container` name links independent availability to container resources. Optional `group` (`Applications` or `Infrastructure`) controls presentation without changing check evaluation or clearing observations. Without an explicit group, TCP checks and checks named Hostboard, Netdata, SSH or watchdog are Infrastructure; other HTTP checks are Applications. Public monitoring APIs omit private targets, headers, response bodies and SMTP recipients. Authorized administrators can view editable endpoints and recipients. Authentication headers, SMTP credentials and expected-content expressions are never returned.

HTTP checks support `url`, `expectedStatuses` (default `[200]`), optional `expectedContent`, `timeoutMs` (100–30000; default 5000), `intervalSeconds` (10–3600; default 60), `failureThreshold` (1–20; default 3), `severity` (`warning` or `critical`), `notify` and `cooldownSeconds` (default 900). TCP checks use `address` and `port`. Up to 100 checks run with concurrency limited to eight. Timeouts include response content. Content inspection is capped at 1 MiB. HTTP error responses and TLS failures fail checks; TLS certificate verification cannot be disabled. Redirects default to rejected; `followRedirects` allows up to five redirects within the original origin. Cross-origin redirects are rejected, preventing forwarded credentials and login pages from silently satisfying health checks. Use private application health endpoints rather than public Access-protected pages. Access protection remains unchanged.

For authenticated health endpoints, `headersEnv` names a server environment variable containing a JSON object of headers. Explicitly pass that environment variable to the container; never put credentials in a URL or a tracked file. A missing or malformed header configuration produces **unknown**, rather than an invented application outage.

Running, Docker healthy, HTTP reachable, TCP accepting connections, and monitoring unavailable are distinct signals. Reachability never proves full application functionality. Failed observations appear as pending until the configured consecutive-failure threshold opens an incident, starting at the first failure in that streak. A successful observation resolves it; unknown observations and stale monitoring never resolve an incident. Gaps reset unconfirmed failure streaks. Changing evaluation configuration retires its open incident with an explicit reason, rather than inventing recovery. Friendly-name/group/notification edits preserve the active incident. All edits retain the check ID and historical samples. Disabling or archiving a check pauses observations and marks an open incident with a monitoring gap; neither action claims recovery. Archived checks can be restored in Settings.

SQLite stores raw check observations for 30 days by default (editable to 365 days) and incident/delivery history indefinitely. Services includes response-time trends and retained last-success timestamps. Issues includes first failure and confirmation times, reasons, recovery, duration, notification attempts, and host investigation links. Daily availability requires at least 80% observed coverage; missing intervals and time before monitoring began remain unknown. Each observation covers at most 1.5 check intervals, so an offline monitor cannot manufacture uptime. Elapsed incident durations may include explicitly marked monitoring gaps. Incident pages return 100 rows at a time, with older-history pagination.

The default Compose mounts `./data` and `./private`. They must be readable/writable as appropriate by container uid 1000. The release helper creates shared directories under the deployment root, symlinks them into releases, and takes a consistent SQLite backup before switching images. Do not delete shared data when pruning releases. Back up SQLite with its backup API, rather than copying only the database while WAL writes are active. Example:

```sh
python3 -c 'import sqlite3; sqlite3.connect("data/monitor.sqlite").backup(sqlite3.connect("monitor-backup.sqlite"))'
```

Private container IPs can change after container recreation. When using bridge IP targets, recheck `docker inspect` and update the deployment destination policy and service endpoint in Settings. Stable private DNS names or private proxy endpoints are preferable when already available. Hostboard does not receive the Docker socket or change application networking.

## SMTP notification delivery

Netdata continues evaluating metric alerts independently of Hostboard. Hostboard only evaluates configured availability checks. Delivery has separate owners to prevent duplicate messages:

- Hostboard sends configured service outage/recovery events.
- The Netdata **parent only** routes its evaluated critical alerts and their eventual clear transitions through [deploy/netdata-notify.conf.example](deploy/netdata-notify.conf.example) and the durable Python SMTP queue. Warning transitions do not resolve an earlier critical incident; only CLEAR does. Child Agent delivery should be disabled when the parent owns notifications.
- The watchdog on another host owns Hostboard/hosting-server/hosting-Agent failures. Set the local Hostboard self-check to `notify: false` to retain observations without duplicate mail.

Copy [config/smtp.example.json](config/smtp.example.json) to ignored `private/smtp.json`, enter the administrator’s SMTP account and approved recipients, restrict permissions to uid 1000 (mode 600), and recreate Hostboard. The default provider supports authenticated SMTP on 587 with required STARTTLS or implicit TLS on 465. Certificate checks and TLS 1.2+ are required. Gmail uses an App Password. Never put passwords in command arguments, Git, logs or browser settings. A provider interface keeps service delivery extensible for future push providers.

Service-level `notify`, `severity`, and cooldowns combine with the SQLite notification preferences. `minimumSeverity` in `checks.json` seeds the initial preference (default `warning`). Application-wide enablement, recovery enablement, recipients, severity and minimum cooldown are editable in Settings. Empty recipient overrides use the existing deployment recipients. Disabling application notifications suppresses pending Hostboard events; enabling them does not replay suppressed history. It does not change Netdata or watchdog queues. Notifications contain the affected service/host, state, start and confirmation/recovery time, reason, response time, and elapsed outage duration. Events are deduplicated, persisted before sending, and retried with bounded exponential delays up to 15 minutes. Repeated observations do not generate reminders. Outage cooldowns also limit flapping; recovery events remain ordered after the corresponding outage. Retries use stable Message-IDs. SMTP acceptance is recorded separately from inbox receipt; an interrupted SMTP acknowledgement can still cause a duplicate (at-least-once delivery). When configuring recipients for the first time, disabled historical events are intentionally not replayed.

For native Netdata delivery, install `scripts/notify.py` as `/usr/local/lib/hostboard/notify.py`, create `/etc/hostboard/smtp.json` readable by the `netdata` group (directory 750, file 640), merge the custom sender example into `/etc/netdata/health_alarm_notify.conf`, and install/enable `deploy/hostboard-notify.{service,timer}`. This queue is `/var/lib/netdata/hostboard-notify.sqlite`; its retry timer and transport run even if Hostboard is stopped. The custom hook queues events immediately and never waits for SMTP. Do not configure the same notification route on child Agents. No Netdata metric collection or storage changes are needed.

Transport test (sends a real email to configured recipients):

```sh
sudo -u netdata python3 /usr/local/lib/hostboard/notify.py --test
```

Check the returned queue summary and timer journal, then verify inbox receipt. A configured transport, successful SMTP login, or an alert execution flag alone is not delivery verification. Do not declare a destination operational until the real test succeeds.

## Independent availability and watchdog supervision

Install `scripts/watchdog.py` and `scripts/notify.py` together under `/usr/local/lib/hostboard` on a different machine with Python 3. Copy `deploy/hostboard-watchdog.{service,timer}` and `deploy/hostboard-watchdog-status.service` to `/etc/systemd/system/`, create `/etc/hostboard-watchdog.env` from the example, then run `systemctl daemon-reload` and enable both the timer and status service.

The watchdog checks private Hostboard HTTP health, the check scheduler’s health, fresh fleet snapshots and the hosting server’s Netdata status. It can use the hosting-server SSH listener as an additional diagnostic when Hostboard fails. It defaults to three consecutive one-minute failures and a 15-minute outage cooldown, with one recovery email including elapsed duration. Changing `HOSTBOARD_WATCH_THRESHOLD` and `HOSTBOARD_WATCH_COOLDOWN` adjusts these settings. `HOSTBOARD_WATCH_REQUIRE_MONITOR=0` supports a temporary rollout against pre-v0.3 Hostboard; leave it enabled for normal operation.

The watchdog uses its own direct Gmail connection and persistent SQLite outbox. Store its host-specific SMTP JSON at `/etc/credstore/hostboard-smtp.json`, root-owned mode 600. systemd passes a private credential copy to the dynamic service user; it never needs an SMTP relay or credential fetch on the monitored host. Missing credentials leave availability checks active with delivery explicitly disabled. A new App Password for each host is preferable when practical; existing authorized credentials can be reused initially.

The private status service listens only on the configured LAN/loopback address and `/health` returns 503 if the watchdog has not run in 180 seconds. Configure an HTTP check for this endpoint on the other host to detect a stopped watchdog/timer or its host’s failure. Set `watchdogHistory: true` on that HTTP check to import independently recorded Hostboard incidents and delivery results into the dashboard after connectivity recovers. Imports never resend independent notifications. The status server reveals only freshness, delivery counts and sanitized incident history, never credentials or private check destinations. Restrict its port to the trusted monitoring network.

State, incident history and delivery attempts persist under `/var/lib/hostboard-watchdog`. Inspect with `systemctl status hostboard-watchdog.timer hostboard-watchdog-status.service`, `journalctl -u hostboard-watchdog.service`, and the SQLite queue. The status service remains up if the timer stops, allowing its stale heartbeat to be detected. If both monitoring hosts or their shared network lose power/connectivity, neither can guarantee notification; an independently powered external monitor would be needed for that scenario. No external service is provisioned automatically. Public Cloudflare Access authentication itself is outside the private-origin watchdog’s scope.

## Release verification and recovery

Browser tests use real Agent and service data and inject request failures to exercise error states. A separate isolated HTTP fixture produces actual 503/200 outage and recovery observations for incident, delivery-failure and bookmark tests; it never sends email or changes production records. Automated coverage includes navigation, issue filters/counts, legacy URLs, service grouping/details, SMTP status and responsive layouts. Set `HOSTBOARD_TEST_URL` to test another instance. HTTP/TCP fixtures, SQLite restarts, SMTP retries/deduplication, and watchdog/freshness failure simulations run locally without stopping production applications.

Release helpers are `scripts/deploy.sh` and `scripts/rollback.sh`. Deployment validates SSH identity, runs tests/build, retains images and source, snapshots SQLite, and restores the previous image on failed startup. Only Hostboard is recreated; Netdata storage is preserved. Run `scripts/rollback.sh RELEASE_DIRECTORY_NAME` on the deployment server to choose a retained image. On v0.4 and later, application configuration is part of the SQLite backup, and bootstrap files no longer overwrite it. Restore the corresponding `config/checks.json.before-*` only when intentionally returning to an older release that uses file-based checks. New v0.3 shared data and credentials remain available after rollback. The runtime image includes the AGPL-3.0 license.

For independent-monitor rollback, restore the backed-up watchdog script, unit and environment file, disable the new status service, then reload systemd and restart the timer. For Netdata notification rollback, restore the previous `health_alarm_notify.conf` and disable `hostboard-notify.timer`. Preserve queue databases for audit/recovery. SMTP credentials are maintained outside release source.
