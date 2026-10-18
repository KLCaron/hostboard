# Images, backups, upgrades and rollback

## Distribution

Stable release image: `ghcr.io/klcaron/hostboard:0.5.3`, Linux amd64/arm64. Each `vX.Y.Z` Git tag must match `package.json`. Publishing runs tests before building, and refuses an existing version tag. Do not move Git tags or republish an existing version. GHCR allows administrators to change tags, so use the published **sha256 manifest digest** for immutable deployments. The GitHub Release records that digest; build metadata/SBOM/provenance are attached to the image. No moving `latest` tag is published. Maintainers may dispatch a verified `candidate-<commit>` image for pre-release acceptance; it is not a stable release. Only reviewed stable semantic versions are released.

Use `HOSTBOARD_IMAGE=ghcr.io/klcaron/hostboard@sha256:...` in `.env` to pin the complete multi-platform release. Keep a copy of the selected source release alongside your deployment files to satisfy source availability and recover the matching helpers. No automatic updater is installed.

The initial v0.5.0 image has a local-login defect. Use v0.5.1 or later; the fix preserves exact-Origin and CSRF validation. Existing Cloudflare Access deployments are unaffected.

## Bridge Compose lifecycle

Run from the release directory, preserving its `.env`, `config`, `private`, and data directory:

```sh
./scripts/manage.sh backup ./backups/manual
./scripts/manage.sh upgrade ghcr.io/klcaron/hostboard:0.5.3 ./backups/before-upgrade
```

Substitute the intended newer version/digest for an actual upgrade. The helper first makes a consistent SQLite online backup plus `.env`, Agent/bootstrap configuration, private authentication/SMTP configuration, and image metadata. Then it pulls the image, persists that reference in `.env`, recreates Hostboard, and waits up to two minutes for container health. Database initialization/migrations occur during startup. Review the release's schema/rollback notes before upgrading. Keep a second copy of backups off-host; credentials are plaintext within these restricted-permission directories. Use encrypted off-host storage appropriate for your environment.

Do not copy only `monitor.sqlite` while it is running: SQLite WAL may contain committed data. Use the helper's backup API. The database contains sample references, incidents, service definitions, preferences, audit and delivery state. Netdata metric history remains at each Agent. Browser-local layout/preferences require a separate browser profile backup/export.

v0.5.2 migrates schema **1 → 2** transactionally, preserving observations as evaluation generation 1. The sample identity index is rebuilt: allow additional disk space approximately equal to the sample table during migration. Older images refuse schema 2. Release acceptance exercises a genuine v0.5.1 → v0.5.2 migration and a paired downgrade to v0.5.1. A schema guard refuses unknown newer versions, but this is not a substitute for a backup.

v0.5.3 adds schema **2 → 3** in an ordered transaction. It adds historical target metadata without rebuilding observations. Existing generations remain explicitly `legacy-unavailable`: current configuration cannot prove their original definitions. Fresh generations retain sanitized metadata. Both schema-1 and actual schema-2 release fixtures are tested. v0.5.2 refuses schema 3; an image-only downgrade is unsupported. Restore its schema-2 pre-upgrade checkpoint, matching private/configuration files and saved image together.

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

The v0.5.3 offline command accepts schemas 1, 2 and 3. Use the saved v0.5.1 image only with its schema-1 checkpoint. For an older release without the maintenance CLI, use its matching restore instructions and paired pre-upgrade database. Never delete WAL files from a running database. Do not run restore while another Hostboard process has the same data directory open.

## Existing SSH / host-network deployments

`scripts/deploy.sh SSH_HOST` retains the release-directory deployment layout and shared private files. It verifies the SSH hostname, runs backend/build/browser tests, copies a curated source list, creates an online SQLite checkpoint, builds an isolated image and recreates only Hostboard using `deploy/compose.host.yaml`. The active release pointer advances after HTTP/scheduler health succeeds. It refuses alternate shared private/data mounts (use the configurable local helper there), saves paired private/config/database checkpoints, and restores the checkpoint before restarting an old image after failed acceptance. It never configures CI SSH or changes independent watchdog/Netdata services. Set `HOSTBOARD_EXPECT_HOSTNAME` when an SSH alias differs from the machine hostname. `SSH_CONFIG` can select a private SSH configuration.

Run `scripts/rollback.sh [RELEASE_DIRECTORY_NAME]` **on the deployment server** to select a saved release. Its schema-1 guard limits this convenience path to verified compatible releases. It backs up the current database first and keeps shared configuration intact. For schema-changing upgrades use a paired database/configuration restore instead. Do not prune rollback images or remove private release pointers until you have another verified recovery path. The bridge lifecycle helper and host-network deployment use the same application/database format but different topology-specific Compose invocations.

## Effective storage mounts and paired restoration

The lifecycle helper requires Python 3, Docker Compose, and directory **bind mounts** at `/app/config`, `/app/private`, and `/app/data`. It resolves Compose configuration and verifies it against the running container before copying. `HOSTBOARD_PRIVATE_DIR` and `HOSTBOARD_DATA_DIR` may select separate alternate or absolute external directories; `./private` is never implicitly substituted. Missing or unreadable required files, symlinks in configuration trees, nested/overlapping mounts, named volumes, or per-file configuration mounts are rejected explicitly. The optional SSH topology uses its own checkpoint procedure.

A backup includes a consistent SQLite snapshot, selected private/config files, saved `.env`, resolved mount manifest, and image identity, with private permissions. It contains credentials: keep an off-host copy securely. Configuration files must remain unchanged during backup. Keep the source image available locally or archive it with `docker image save`.

Rollback validates the database, configuration and saved image before stopping Hostboard. It restores configuration into the mounts selected by the **saved** environment, restores the database there, and pins the exact saved local image ID. The source image must be available locally or still obtainable with the same content ID. Mount paths are installation-specific; for a different machine, provision the saved paths and ownership before restoring. Do not change storage variables through exported shell overrides during rollback. A pre-restore checkpoint is retained. Restore is not a crash-atomic transaction across filesystems: after interruption, keep Hostboard stopped and repeat the paired restore from an intact checkpoint.

v0.5.2 databases cannot be opened by v0.5.1. Downgrade with the schema-1 **pre-upgrade database and matching private configuration/image**. Never run the old image directly against schema 2. Post-checkpoint observations remain in the pre-restore safety copy, not the restored timeline.

## Monitoring capacity and history

Eight probes run concurrently, at most one per check. The interval is a delay after completion; oldest-due checks receive capacity first. Ordinary request execution time does not reset consecutive failure evidence. A scheduling heartbeat detects gaps longer than five seconds using wall and monotonic clocks, including pauses during requests and callbacks delivered before a resumed scheduler tick. All results spanning an interruption become unknown; unconfirmed evidence resets, confirmed incidents retain their identity and receive a monitoring-gap marker. Coverage stops at the last observed scheduling opportunity and health remains unavailable until fresh trustworthy observations arrive. Timer jitter within five seconds is tolerated; this is not continuous observation of the remote service. A missing observation, scheduler interruption or disabled check is unknown monitoring time. Overdue probe starts keep monitor health unavailable even immediately after fresh responses; overload also makes observations stale. It does not fabricate a service failure. Tune intervals to the number and duration of checks rather than expecting 100 slow checks to run every ten seconds.

Daily histories use linear bucket processing, a shared five-second cache, and yield between checks. Current state and health are read directly from observations. `/api/system` does not calculate trends. Retention deletion is indexed and limited to 5000 rows per scheduler tick. The default 30-day, 100-check, ten-second configuration can retain about 25.9 million rows; provision disk accordingly. A 365-day setting can exceed 315 million rows. The count limit is not a promise that every interval is achievable under every timeout/retention setting. Incidents/outbox history are retained indefinitely; SQLite reuses deleted pages and does not automatically shrink its file.
