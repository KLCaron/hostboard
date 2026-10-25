# Images, backups, upgrades and rollback

## Distribution

Stable release image: `ghcr.io/klcaron/hostboard:0.7.1`, Linux amd64/arm64. Each `vX.Y.Z` Git tag must match `package.json`. Publishing runs tests before building, and refuses an existing version tag. Do not move Git tags or republish an existing version. GHCR allows administrators to change tags, so use the published **sha256 manifest digest** for immutable deployments. The GitHub Release records that digest; build metadata/SBOM/provenance are attached to the image. No moving `latest` tag is published. Maintainers may dispatch a verified `candidate-<commit>` image for pre-release acceptance; it is not a stable release. Only reviewed stable semantic versions are released.

The current `main` source version is 0.9.0. Its Update Monitor, issue handling, container cards, and newer dependency fixes are not part of the v0.7.1 image. Use a [local source build](installation.md#build-from-source) for those changes until a new release is published. The guides on `main` describe that code; use a release checkout's own guides for its image. Do not select an image based only on the source version or `.env.example` default.

`v0.6.0` remains an early candidate Git tag; no stable v0.6.0 image or GitHub Release was published. v0.6.1 established the centralized Logs explorer; v0.6.2 adds consistent navigation, contextual links and interaction states across all six sections. It keeps schema 3, the existing source identities, log query bounds and adapter privileges unchanged.

Use `HOSTBOARD_IMAGE=ghcr.io/klcaron/hostboard@sha256:...` in `.env` to pin the complete multi-platform release. Keep a copy of the selected source release alongside your deployment files to satisfy source availability and recover the matching helpers. No automatic updater is installed.

The initial v0.5.0 image has a local-login defect. Use v0.5.1 or later; the fix preserves exact-Origin and CSRF validation. Existing Cloudflare Access deployments are unaffected.

## Bridge Compose lifecycle

Run from the release directory, preserving its `.env`, `config`, `private`, and data directory:

```sh
./scripts/manage.sh backup ./backups/manual
./scripts/manage.sh upgrade ghcr.io/klcaron/hostboard:0.7.1 ./backups/before-upgrade
```

Substitute the intended newer version/digest for an actual upgrade. The helper first makes a consistent SQLite online backup plus `.env`, Agent/bootstrap configuration, private authentication/SMTP configuration, and image metadata. Then it pulls the image, persists that reference in `.env`, recreates Hostboard, and waits up to two minutes for container health. Database initialization/migrations occur during startup. Review the release's schema/rollback notes before upgrading. Keep a second copy of backups off-host; credentials are plaintext within these restricted-permission directories. Use encrypted off-host storage appropriate for your environment.

Do not copy only `monitor.sqlite` while it is running: SQLite WAL may contain committed data. Use the helper's backup API. The database contains sample references, incidents, service definitions, preferences, audit and delivery state. Netdata metric history remains at each Agent. Browser-local layout/preferences require a separate browser profile backup/export.

v0.5.2 migrates schema **1 → 2** transactionally, preserving observations as evaluation generation 1. The sample identity index is rebuilt: allow additional disk space approximately equal to the sample table during migration. Older images refuse schema 2. Release acceptance exercises a genuine v0.5.1 → v0.5.2 migration and a paired downgrade to v0.5.1. A schema guard refuses unknown newer versions, but this is not a substitute for a backup.

v0.5.3 adds schema **2 → 3** in an ordered transaction. It adds historical target metadata without rebuilding observations. Existing generations remain explicitly `legacy-unavailable`: current configuration cannot prove their original definitions. Fresh generations retain sanitized metadata. Both schema-1 and actual schema-2 release fixtures are tested. v0.5.2 refuses schema 3; an image-only downgrade is unsupported. Restore its schema-2 pre-upgrade checkpoint, matching private/configuration files and saved image together.

## Locally built images

`scripts/manage.sh upgrade` pulls its selected image and is intended for registry images. For a locally built deployment, make the same paired backup before changing code or configuration and keep the saved image available locally. Build the new source under a distinct local image tag, set that tag as `HOSTBOARD_IMAGE` in `.env`, and recreate only Hostboard with `docker compose up -d --wait --wait-timeout 120 hostboard`. Verify fresh metrics and administrator access. Keep the previous image until the new build is accepted; the paired rollback helper can restore its saved local image ID. Reusing a tag without preserving its old image can remove that recovery path.

## Paired restore

```sh
./scripts/manage.sh rollback ./backups/before-upgrade
```

While the application is healthy enough for an online backup, the helper saves current data to a new `backups/before-restore-*` directory, stops Hostboard, restores the selected checkpoint's configuration and `.env`, validates the backup database, replaces SQLite while stopped, and starts the saved image. Later observations/configuration changes are lost from the restored timeline; the pre-restore backup keeps a recovery copy. Hold on to the old image locally and ensure its exact tag/digest is still pullable.

If a failed migration prevents startup entirely, online backup cannot run. Stop the service with `docker compose stop hostboard`, preserve the **entire stopped data directory** (including WAL/SHM), `.env`, `config` and `private` in a new private directory, restore the saved `.env`/configuration, and run the offline restore with that saved image:

```sh
# BACKUP_DIR must be an absolute path to a paired backup. Application must be stopped.
docker compose run --rm --no-deps -T --entrypoint node hostboard dist/server/server/maintenance.js restore - < "$BACKUP_DIR/monitor.sqlite"
docker compose up -d --wait
```

The v0.7.1 and current `main` maintenance commands accept schemas 1–4; older commands may accept fewer. Select the saved image that matches the checkpoint, rather than relying on a newer validator's range to establish application compatibility. For an older release without the maintenance CLI, use its matching restore instructions and paired pre-upgrade database. Never delete WAL files from a running database. Do not run restore while another Hostboard process has the same data directory open.

## Existing SSH / host-network deployments

`scripts/deploy.sh SSH_HOST` retains the release-directory deployment layout and shared private files. It verifies the SSH hostname, runs backend/build/browser tests, copies a curated source list, creates an online SQLite checkpoint, builds an isolated image and recreates only Hostboard using `deploy/compose.host.yaml`. The helper resolves release-directory bind-mount symlinks before checking storage boundaries, records the actual running image ID/reference (including an accepted-image override), and restores that exact image with the paired database/config checkpoint on failed startup or health acceptance. The active release pointer advances after HTTP/scheduler health succeeds. It refuses alternate shared private/data mounts (use the configurable local helper there), saves paired private/config/database checkpoints, and restores the checkpoint before restarting an old image after failed acceptance. It never configures CI SSH or changes independent watchdog/Netdata services. Set `HOSTBOARD_EXPECT_HOSTNAME` when an SSH alias differs from the machine hostname. `SSH_CONFIG` can select a private SSH configuration.

Run `scripts/rollback.sh [RELEASE_DIRECTORY_NAME]` **on the deployment server** to select a saved release. Its schema-1 guard limits this convenience path to verified compatible releases. It backs up the current database first and keeps shared configuration intact. For schema-changing upgrades use a paired database/configuration restore instead. Do not prune rollback images or remove private release pointers until you have another verified recovery path. The bridge lifecycle helper and host-network deployment use the same application/database format but different topology-specific Compose invocations.

## Effective storage mounts and paired restoration

The lifecycle helper requires Python 3, Docker Compose, and directory **bind mounts** at `/app/config`, `/app/private`, and `/app/data`. It resolves Compose configuration and verifies it against the running container before copying. `HOSTBOARD_PRIVATE_DIR` and `HOSTBOARD_DATA_DIR` may select separate alternate or absolute external directories; `./private` is never implicitly substituted. Missing or unreadable required files, symlinks in configuration trees, nested/overlapping mounts, named volumes, or per-file configuration mounts are rejected explicitly. The optional SSH topology uses its own checkpoint procedure.

A backup includes a consistent SQLite snapshot, selected private/config files, saved `.env`, resolved mount manifest, and image identity, with private permissions. It contains credentials: keep an off-host copy securely. Configuration files must remain unchanged during backup. Keep the source image available locally or archive it with `docker image save`.

Rollback validates the database, configuration and saved image before stopping Hostboard. It restores configuration into the mounts selected by the **saved** environment, restores the database there, and pins the exact saved local image ID. The source image must be available locally or still obtainable with the same content ID. Mount paths are installation-specific; for a different machine, provision the saved paths and ownership before restoring. Do not change storage variables through exported shell overrides during rollback. A pre-restore checkpoint is retained. Restore is not a crash-atomic transaction across filesystems: after interruption, keep Hostboard stopped and repeat the paired restore from an intact checkpoint.

v0.5.2 databases cannot be opened by v0.5.1. Downgrade with the schema-1 **pre-upgrade database and matching private configuration/image**. Never run the old image directly against schema 2. Post-checkpoint observations remain in the pre-restore safety copy, not the restored timeline.

## Monitoring capacity and history

Eight probes run concurrently, at most one per check. The interval is a delay after completion; oldest-due checks receive capacity first. Ordinary request execution time does not reset consecutive failure evidence. A scheduling heartbeat detects gaps longer than five seconds using wall and monotonic clocks, including pauses during requests and callbacks delivered before a resumed scheduler tick. All results spanning an interruption become unknown; unconfirmed evidence resets, confirmed incidents retain their identity and receive a monitoring-gap marker. Coverage stops at the last observed scheduling opportunity and health remains unavailable until fresh trustworthy observations arrive. Timer jitter within five seconds is tolerated; this is not continuous observation of the remote service. A missing observation, scheduler interruption or disabled check is unknown monitoring time. Overdue probe starts keep monitor health unavailable even immediately after fresh responses; overload also makes observations stale. It does not fabricate a service failure. Tune intervals to the number and duration of checks rather than expecting 100 slow checks to run every ten seconds.

Daily histories use linear bucket processing, a shared five-second cache, and yield between checks. Current state and health are read directly from observations. `/api/system` does not calculate trends. Retention deletion is indexed and limited to 5000 rows per scheduler tick. The default 30-day, 100-check, ten-second configuration can retain about 25.9 million rows; provision disk accordingly. A 365-day setting can exceed 315 million rows. The count limit is not a promise that every interval is achievable under every timeout/retention setting. Incidents/outbox history are retained indefinitely; SQLite reuses deleted pages and does not automatically shrink its file.

## v0.7.0 server registration

Schema 3 migrates transactionally to schema 4, importing static Agent IDs once and retaining all service, incident and log associations. Agent destinations remain deployment-approved separately from the editable registry. See [server connections and discovery](servers.md) for policy, onboarding, grouping, API compatibility and limits. v0.6.2 cannot open schema 4; roll back only with its paired pre-upgrade database, configuration and preserved image. Backup/restore validators accept schemas 1–4, but that does not make older images compatible with newer schemas.

## Availability across server failures

The supplied deployment is a single application instance with a local SQLite database. Docker's restart policy handles a process or container restart on a working host; it does not move the application to another machine. An independent watchdog on another host can report an outage while Hostboard is unavailable, but it cannot serve the dashboard or take over its service checks. An off-host backup enables recovery, not automatic availability.

Review the complete request and monitoring paths: public DNS/Access, tunnel connector, application, database/configuration, metric Agents or streaming parents, service destinations, SSH adapters and notification owners. A second application that still reads every node through the original parent, or a second tunnel that still forwards to the original machine, retains that machine as a dependency. Localhost service-check targets must be made reachable from the replacement monitor; the same loopback address on another machine identifies a different destination. Update approved target IPs, Agent policy, SSH source restrictions and pinned keys deliberately while preserving authentication.

| Option | Availability and history | Required work |
| --- | --- | --- |
| Warm standby with paired off-host backups | Restore on another host after operator intervention; observations since the checkpoint may be lost. | Retain the image/config/database together, prepare replacement targets and tunnel routing, and rehearse restore. Lowest complexity; the site still has an outage. |
| Two independent installations | A healthy instance can keep a dashboard available after either application host fails; each owns separate settings, incidents and history. | Use independent Agent paths and local databases, health-based public routing, and explicit notification ownership to prevent duplicates. Keep configuration aligned. This is redundancy, not shared-state failover. |
| One active installation with automatic standby promotion | Preserves one logical monitoring service with a bounded failover interruption and an explicitly chosen data-loss window. | Engineer database/config replication, promotion, quorum/fencing to prevent two active schedulers, independent ingress/metric paths and notification queue ownership. Hostboard does not currently implement this orchestration. |

For one logical service with continuous incident history, prefer an active/standby design over casually running two notification schedulers. A three-machine quorum can tolerate one lost voter, but requires a working HA controller and fencing; having three Docker hosts alone provides neither. The application database, separate Netdata notification queue, and independent watchdog queue have distinct owners and recovery needs. Restore or promotion must account for pending emails and avoid replaying already-delivered events. Local authentication sessions are in memory and require signing in again after restart or failover.

Do not mount the same live SQLite database read/write on multiple servers. Hostboard uses WAL, which [requires all database processes to run on the same host](https://www.sqlite.org/wal.html). Use consistent online backups for a restore-based standby; tighter replication needs a separately validated solution. Ordinary file copying or a shared NAS does not supply transaction-safe replication or protect against two active writers.

[Cloudflare tunnel replicas](https://developers.cloudflare.com/tunnel/configuration/) add connector availability. Every selected connector still needs a working origin path. [Health-based load balancing across separate tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/public-load-balancers/) can steer around a failed origin, subject to the account's product availability; it does not replicate Hostboard state. A local redundant proxy/VIP is another routing option, with its own failover controller and healthy origins. Retain Access coverage on every public route.

For metric continuity, use direct private Agent endpoints or a redundant Netdata parent design, and decide where historical retention must survive. [Netdata supports alternative parents for connection failover](https://learn.netdata.cloud/docs/edge-device-monitoring); parent storage and alert evaluation/notification ownership still need separate planning. Moving Hostboard to a different single machine only moves the application dependency. A small external host can provide a useful independent dashboard/watchdog, but a lone external host is also a single instance.

Before implementation, choose a recovery-time target, acceptable lost observations, whether one unified incident/settings history is required, and whether the goal covers only the monitoring site or every monitored application. Keeping Hostboard available does not make a Foundry, media, database or other workload on a failed server available. Final acceptance should exercise each host failure in turn, network partitions and recovery: verify the public URL, authentication, fresh metrics from survivors, incident identity, notification ownership and restoration. Shared power, switch/router, Internet and SMTP-provider failures remain separate failure domains.

## Handling individual issues

Administrators can select **Manage issue** on an active metric alert or availability incident in Issues. Actions require a reason and apply globally across browsers. They persist in SQLite and appear under **Handled**, with the operator, timestamp and **Restore alert** action.

- **Acknowledge this occurrence** removes the current occurrence from Active. A new Netdata alert occurrence or a new availability incident appears again.
- **Snooze** hides the specific condition for one hour, 24 hours or seven days. Expiry makes a still-active condition visible again.
- **Treat as expected / ignore** hides the specific condition until restored. Metric rules are scoped to the pinned server identity, alert name, resource and evaluated rules; availability rules are scoped to server identity, check ID and generation. Replacing a server or changing a rule/check target does not inherit the old dismissal. A warning escalating to critical always resurfaces.

Handling changes the Active list and counts, not observations, severity, service health, availability calculations or incident resolution. Host cards link to handled alerts and Overview identifies known handled conditions rather than declaring them healthy. Collection continues. History, direct alert/incident links, source state and configuration audit remain available. Failed or inconsistent detail coverage leaves source alerts visible instead of trusting a handling rule.

Hostboard service-check emails for matching incidents are suppressed, including queued messages not yet being sent. Previously delivered messages cannot be recalled, and suppressed messages are not replayed when a snooze expires or a rule is restored. **Netdata custom delivery, Netdata Cloud and the independent watchdog retain their own notification configuration.** Hostboard's metric handling is a local presentation decision; it does not modify the Agent's health engine or baseline. The action dialog explains this scope. To accept a changed hardware inventory at its source, use the collector's documented operator procedure; future inventory loss should continue to alert.

Writes enforce the existing local/Cloudflare administrator authorization, same-origin JSON/CSRF checks, shared configuration revision and audit. Source lookup validates the actual current issue and pinned node; the browser cannot invent a rule or target an arbitrary Agent endpoint. At most 500 condition rules are stored. The additive table does not change schema version 4; include it through the normal paired database backup. Older images do not enforce handling rules, so rolling back requires the existing paired image/config/database procedure.

## Netdata Cloud notification ownership

Agent delivery and Cloud delivery are configured independently. `SEND_EMAIL="NO"` disables ordinary Agent email; retaining `SEND_CUSTOM="YES"` on the notification-owning parent preserves the custom durable delivery path. Do not disable the health engine to silence Cloud emails.

To stop only your Cloud emails, open your Netdata Cloud profile, **Settings → Notifications**, and disable Email. For Space-wide changes, an administrator can open **Space Settings → Alerts & Notifications → Notification Methods** and disable Email (and any separately configured Group Email destination that should stop). The [official notification-method guide](https://learn.netdata.cloud/docs/alerts-%26-notifications/notifications/centralized-cloud-notifications/manage-notification-methods) describes these independent scopes. These are Cloud-account changes; changing an Agent's SMTP settings does not change them.
