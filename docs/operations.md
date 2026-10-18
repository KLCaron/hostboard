# Images, backups, upgrades and rollback

## Distribution

Stable release image: `ghcr.io/klcaron/hostboard:0.5.0`, Linux amd64/arm64. Each `vX.Y.Z` Git tag must match `package.json`. Publishing runs tests before building, and refuses an existing version tag. Do not move Git tags or republish an existing version. GHCR allows administrators to change tags, so use the published **sha256 manifest digest** for immutable deployments. The GitHub Release records that digest; build metadata/SBOM/provenance are attached to the image. No moving `latest` tag is published. Only reviewed stable semantic versions are released.

Use `HOSTBOARD_IMAGE=ghcr.io/klcaron/hostboard@sha256:...` in `.env` to pin the complete multi-platform release. Keep a copy of the selected source release alongside your deployment files to satisfy source availability and recover the matching helpers. No automatic updater is installed.

## Bridge Compose lifecycle

Run from the release directory, preserving its `.env`, `config`, `private`, and data directory:

```sh
./scripts/manage.sh backup ./backups/manual
./scripts/manage.sh upgrade ghcr.io/klcaron/hostboard:0.5.0 ./backups/before-upgrade
```

Substitute the intended newer version/digest for an actual upgrade. The helper first makes a consistent SQLite online backup plus `.env`, Agent/bootstrap configuration, private authentication/SMTP configuration, and image metadata. Then it pulls the image, persists that reference in `.env`, recreates Hostboard, and waits up to two minutes for container health. Database initialization/migrations occur during startup. Review the release's schema/rollback notes before upgrading. Keep a second copy of backups off-host; credentials are plaintext within these restricted-permission directories. Use encrypted off-host storage appropriate for your environment.

Do not copy only `monitor.sqlite` while it is running: SQLite WAL may contain committed data. Use the helper's backup API. The database contains sample references, incidents, service definitions, preferences, audit and delivery state. Netdata metric history remains at each Agent. Browser-local layout/preferences require a separate browser profile backup/export.

Schema version remains **1** in v0.5.0. v0.4.1 database/configuration compatibility is checked during release acceptance. Future database migrations may prevent opening the result with an old image. A schema guard refuses unknown newer versions, but this is not a substitute for a backup.

## Paired restore

```sh
./scripts/manage.sh rollback ./backups/before-upgrade
```

While the application is healthy enough for an online backup, the helper saves current data to a new `backups/before-restore-*` directory, stops Hostboard, restores the selected checkpoint's configuration and `.env`, validates the backup database, replaces SQLite while stopped, and starts the saved image. Later observations/configuration changes are lost from the restored timeline; the pre-restore backup keeps a recovery copy. Hold on to the old image locally and ensure its exact tag/digest is still pullable.

If a failed migration prevents startup entirely, online backup cannot run. Stop the service with `docker compose stop hostboard`, preserve the **entire stopped data directory** (including WAL/SHM), `.env`, `config` and `private` in a new private directory, restore the saved `.env`/configuration, and run the offline restore with that saved image:

```sh
# BACKUP_DIR must be an absolute path to a paired backup. Application must be stopped.
docker compose run --rm --no-deps -T --volume "$BACKUP_DIR:/backup:ro" --entrypoint node hostboard dist/server/server/maintenance.js restore /backup/monitor.sqlite
docker compose up -d --wait
```

The offline command handles schema-1 backups created by v0.5.0 helpers. For an older release without the maintenance CLI, use its matching restore instructions and paired pre-upgrade database. Never delete WAL files from a running database. Do not run restore while another Hostboard process has the same data directory open.

## Existing SSH / host-network deployments

`scripts/deploy.sh SSH_HOST` retains the release-directory deployment layout and shared private files. It verifies the SSH hostname, runs backend/build/browser tests, copies a curated source list, creates an online SQLite checkpoint, builds an isolated image and recreates only Hostboard using `deploy/compose.host.yaml`. The active release pointer advances after HTTP/scheduler health succeeds. It never configures CI SSH or changes independent watchdog/Netdata services. Set `HOSTBOARD_EXPECT_HOSTNAME` when an SSH alias differs from the machine hostname. `SSH_CONFIG` can select a private SSH configuration.

Run `scripts/rollback.sh [RELEASE_DIRECTORY_NAME]` **on the deployment server** to select a saved release. Its schema-1 guard limits this convenience path to verified compatible releases. It backs up the current database first and keeps shared configuration intact. For schema-changing upgrades use a paired database/configuration restore instead. Do not prune rollback images or remove private release pointers until you have another verified recovery path. The bridge lifecycle helper and host-network deployment use the same application/database format but different topology-specific Compose invocations.
