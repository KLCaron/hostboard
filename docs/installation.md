# Installation

Use the [README quick start](../README.md) for a new installation. The published image includes the setup CLI and database initialization; no private files, build tools, external database, Netdata Cloud account, or Cloudflare account are required.

## Setup

Run `./scripts/setup.sh` from a release checkout. Choose an exact browser origin without a trailing slash. For local login, use HTTPS for remote access or HTTP on `localhost` / loopback with an SSH tunnel. Choose a strong unique password of at least 16 characters. There are no default credentials or registration endpoint.

The CLI creates `.env`, `config/hosts.json`, `config/checks.json`, `private/admin.json`, and optionally `private/smtp.json`. It validates all answers before writing files. Existing files are preserved and cause setup to stop; use `./scripts/setup.sh --check` to validate an existing installation. A failed optional SMTP connection does not block startup. An invalid SMTP file must be corrected or removed; a missing file simply disables delivery.

Service checks are optional and start empty. After login, approve targets in the private policy and add checks in Settings. Seed checks can also be specified in `config/checks.json` **before first startup**. See [service checks](service-checks.md).

The CLI writes the invoking user's unprivileged UID/GID into `.env`. If invoked as root it assigns configuration/data to container uid/gid 1000 instead. Bind mounts must be readable by the configured container user, with data writable. The `.env` file can remain owned by the host operator. Do not run the application as root. Avoid world-readable credentials; default private files are mode 600 and the private/data directories mode 700. An alternate data directory must start with `./` or `/` and contain no spaces or shell syntax.

For manual setup, copy `.env.example` and `config/hosts.example.json`, create an empty checks file, and follow [authentication](authentication.md) to create administrator configuration. The CLI is recommended because it generates the password hash and session secret correctly.

## External data directories

The `scripts/setup.sh` wrapper mounts only the project directory. Use `./data` or another directory **inside the project** with that wrapper. An absolute host directory must also be mounted into the setup container at the same path; otherwise setup cannot prepare the host's storage or its permissions.

For a fresh installation using external storage, run this instead of `scripts/setup.sh`:

```sh
DATA_DIR="$HOME/hostboard-data"
install -d -m 700 "$DATA_DIR"
docker run --rm -it --user "$(id -u):$(id -g)" \
  --volume "$PWD:/setup" --volume "$DATA_DIR:$DATA_DIR" --entrypoint node \
  ghcr.io/klcaron/hostboard:0.7.1 dist/server/server/setup.js --directory /setup
```

Enter the exact absolute value of `DATA_DIR` at the persistent data directory prompt. Then run `./scripts/setup.sh --check` and `docker compose up -d --wait` normally. Use a path without spaces or shell syntax. This flow was verified with external SQLite storage, an unavailable Agent, and container recreation. Existing installations should stop Hostboard and retain a consistent backup before moving data or changing `HOSTBOARD_DATA_DIR`.

## HTTPS proxy

Keep Hostboard published on loopback when a proxy runs on the Docker host. Forward the original Host header, and set `X-Forwarded-Proto: https` on HTTPS requests. Configure the **actual connecting proxy IP** in local `private/admin.json`'s `trustedProxies`; a host proxy normally appears as the Docker bridge gateway, rather than 127.0.0.1. Inspect your network to determine it. Do not use wildcard proxy trust. Set the `origin` and `HOSTBOARD_PUBLIC_URL` to the exact external HTTPS origin, then recreate Hostboard. A proxy on a separate machine needs access to the explicitly published private interface, with firewall restrictions.

Cookies will not be issued for an HTTPS origin through an untrusted HTTP proxy. Requiring an exact Origin protects sign-in and mutations; accessing the app through a different hostname or port will prevent writes. Health endpoints remain available without credentials and reveal only status.

## Verify

```sh
docker compose config --quiet
docker compose ps
docker compose logs --tail 50 hostboard
```

The container must become healthy. Sign in, check that your server appears online, open a historical chart, and verify Settings permits administrator changes. Missing optional SMTP or service checks should not prevent startup. `docker compose down` removes the container/network while preserving bind-mounted configuration and data. Never delete `data/` to troubleshoot a startup problem without a backup.

## Build from source

```sh
docker build -t hostboard:local .
HOSTBOARD_IMAGE=hostboard:local ./scripts/setup.sh
```

Set `HOSTBOARD_IMAGE=hostboard:local` in the generated `.env` before `docker compose up -d --wait`. Published images avoid this build step. Architecture support is Linux amd64/arm64; Docker Desktop and other operating systems are not part of the release acceptance matrix.

## Independent watchdog and authentication

Run the optional watchdog on a different machine with private connectivity to Hostboard and the required Netdata Agents. Use `deploy/hostboard-watchdog.env.example` and the supplied service/timer units. Configure `HOSTBOARD_WATCH_AGENTS` as a JSON array of private Agent origins and exact node selectors. In **both local and Cloudflare modes**, this recommended setup checks only Hostboard's status-only health endpoints and reads fresh, node-verified CPU observations directly from Netdata. It needs no Hostboard administrator password, browser session, or machine API credential. Protect Agent network access and keep the watchdog's own SMTP credentials on the independent host.

The protected `/api/fleet` API remains authenticated in local mode. Omitting `HOSTBOARD_WATCH_AGENTS` retains the legacy fleet check only for a trusted private Cloudflare-mode origin; it cannot work against a local-login installation or a public Access login URL. `HOSTBOARD_WATCH_REQUIRE_MONITOR=0` skips only the scheduler-specific request; it does not grant fleet access. Check watchdog status freshness as well as Hostboard's own health so a stopped independent timer is visible. Existing watchdog/Netdata notification paths must remain active during upgrades.
