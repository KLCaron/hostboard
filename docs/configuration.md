# Configuration reference

Files containing real configuration are Git-ignored. None is included in the image.

| File | Purpose / lifecycle |
| --- | --- |
| `.env` | Published image, host interface/port, browser URL, data/private directories, container UID/GID; read by Compose |
| `config/hosts.json` | 1–20 Agent/node entries; read on startup; changes require recreation |
| `config/checks.json` | Optional bootstrap checks; imported only when SQLite settings are first initialized |
| `private/admin.json` | Authentication and exact allowed service targets; required; startup validation |
| `private/smtp.json` | Optional SMTP transport credentials; startup validation |
| `data/monitor.sqlite` (+ WAL/SHM) | Persistent preferences, editable services, incidents, samples, notification queue, audit history |

See [.env.example](../.env.example) for deployment defaults. Docker mounts config/private read-only and data read/write. The default image runs as uid/gid 1000, overridden by the unprivileged UID/GID selected during setup. The filesystem is otherwise read-only, all capabilities are dropped, and no Docker socket is mounted.

## Agent entries

`id`: unique `[a-zA-Z0-9_-]`, 1–64 characters. `name`: display label, 1–80 characters. `url`: HTTP(S) origin, no path, embedded credentials, query, or fragment. `node`: exact hostname/GUID/UUID from `/api/v3/nodes`, no wildcards. Optional `tokenEnv`: an explicitly passed environment variable name containing a bearer token. Optional `addresses`: literal approved IP list; omitted names are pinned on first successful DNS resolution for this process. Wrong/ambiguous node selectors produce a visible connection error rather than mixing hosts.

## Local admin policy

Setup generates the hash/secret; do not copy placeholders into a running installation:

```json
{
  "mode": "local",
  "origin": "http://localhost:8088",
  "username": "your-admin",
  "passwordHash": "GENERATED_BY_SETUP",
  "sessionSecret": "GENERATED_BY_SETUP",
  "trustedProxies": [],
  "targets": []
}
```

`origin` must exactly match browser scheme, hostname and port. Non-loopback HTTP origins are refused. `trustedProxies` contains only literal connecting proxy IPs; empty means no forwarding-header trust. `targets` grants exact host/port/address combinations, including approved internal destinations. See [authentication](authentication.md) and [service checks](service-checks.md) for functioning examples.

## SMTP

Use [smtp.example.json](../config/smtp.example.json). `host`, `port` (465 or 587), `username`, `password`, `from`, and `to` are required if the file is present. TLS and certificate verification are required. `username` may be a provider-specific login. Gmail app passwords remain supported, but any compatible authenticated SMTP server works. Preferences cannot expose or change transport credentials. Recipient preference overrides the deployment `to` list when nonempty. Missing SMTP disables delivery without preventing monitoring. Do not use actual credentials in shell command arguments, Git, or issue reports.

## Advanced backend environment

`PORT` / `HOSTBOARD_BIND` control direct Node/host-network listeners (default 3001 / 127.0.0.1); bridge Compose deliberately sets internal port 8088 and wildcard bind. `HOSTBOARD_CONTAINER=1` allows the internal wildcard. `HOSTBOARD_CONFIG`, `HOSTBOARD_CHECKS`, `HOSTBOARD_DB`, `HOSTBOARD_ADMIN_CONFIG`, and `HOSTBOARD_SMTP_CONFIG` select file paths. `HOSTBOARD_PUBLIC_URL` is used in notification links, not as an authentication trust source. Changing it does not change the required admin Origin. Production image metadata is in `/app/package.json` and OCI labels.

Settings defaults: 10-second refresh, Celsius, 1-hour historical window, Overview landing page, 30-day service samples and indefinite incident retention. Netdata supplies metric retention. Personal preferences/layouts remain browser-local; server backups do not include browser storage.

Server registrations and primary groups are persisted in schema-4 SQLite. `config/hosts.json` is now a one-time bootstrap and compatibility trust source; later edits do not overwrite the registry. Agent origins and pinned IP approval remain operator-controlled in optional `private/agents.json`. See [server management](servers.md).
