# Container logs and incident investigation

Hostboard optionally reads existing **Docker-managed stdout/stderr** on approved hosts. It does not collect or retain log bodies, change Docker logging settings, require Netdata Cloud, or add a log database. A normal Compose installation needs no log configuration and retains its monitoring features.

## Workflow

- Open **Logs** in the main navigation for the full-width explorer. **View logs** on services, container resources and investigation dialogs opens that same page with a confirmed context. Host, source and exact query window are bookmarkable; search terms and log bodies stay out of URLs.
- In **Settings → Log Sources**, an administrator selects a service or container, reviews existing associations and saves one or more approved sources. Clear associations to remove mappings. Unavailable and no-longer-approved sources are distinguished from an unconfigured mapping. Hostboard does not infer identity from a health-check name. Choose a source when multiple containers belong to a service.
- Under **Issues**, expand an incident and choose **View related logs**. A confirmed mapping for that exact historical service generation selects its source; otherwise configure and confirm the association in Settings. The initial window starts 15 minutes before the incident and ends 15 minutes after recovery (or onset for an active incident), capped at now and 24 hours. Long incidents initially show their onset. Adjust the dates for other periods.
- Choose 15 minutes, 1 hour, 6 hours or 24 hours, or enter custom local timestamps. Entries display local time by default, including the date and timezone; choose UTC for exact Docker timestamps. Query and copied/downloaded timestamps retain the original UTC values. Search uses literal substrings with optional case sensitivity and stream selection; no shell or regular-expression evaluation occurs.
- **Resume live tail** polls every three seconds. Pause before selecting, copying, downloading or inspecting earlier output. Scrolling upward, touch scrolling, Page Up, Home and Escape pause live mode. An incident older than the live window opens a fresh 15-minute live range; the incident and metrics links remain available.
- Select individual entries or **Select displayed**, then deliberately copy or download that selection. Downloads are generated in the browser from the bounded displayed buffer; there are no log-sharing URLs. Use **Wrap lines** for responsive multiline output or turn it off to scroll long lines inside the log panel. Mobile places timestamps and stream labels above the full-width message. JSON objects can be expanded into fields. Highlighting recognizes explicit structured levels and conventional ERROR/WARN prefixes; stderr alone does not establish severity.

Only a server-authorized local administrator or signed, allowlisted Cloudflare Access administrator can access any log endpoint, including source metadata and mappings. A protected public page alone does not authorize logs. Administrative requests also enforce the existing same-origin JSON/CSRF policy. Log bodies and search terms are excluded from application audit records. A bounded access audit in SQLite records actor, time, host, source and action. Clipboard, downloads, private backups and browser memory still contain sensitive data; access controls do not make arbitrary logs safe for publication.

## Security boundary and privileges

The main application has **no Docker socket**. It invokes the system SSH client with a dedicated key, strict pinned host keys, fixed destinations from deployment-owned configuration, no agent, no proxy command, no forwarding and no shell interpolation. Each host’s `hostboard-logs` account is restricted by both sshd and authorized_keys to one root-owned Python program. SSH encrypts and authenticates the connection; no new listening service or unauthenticated port is introduced. Restrict the authorized key to the exact Hostboard source IP and keep SSH on a trusted network.

The helper permits only a bounded JSON `sources` or `query` request. Its only Docker operations are fixed **GET container list (label-filtered), GET inspect (resolved full ID), and GET logs** requests over the local Unix socket. It does not call the Docker CLI, spawn commands, accept filesystem paths/URLs/API methods, execute in containers, or manage containers. Queries can target only root-managed source IDs. Label selectors must resolve to exactly one container; ambiguous or absent matches fail explicitly. Use project, service and replica labels together, or a full immutable container ID. Exclude one-off jobs. Neither a name nor a short ID grants access.

**Residual risk:** the helper account belongs to the Docker socket group, which is root-equivalent on a normal Docker host. Mounting that socket read-only would not restrict its API. A helper implementation vulnerability or local compromise of that account could escape the intended read-only protocol and control the host. The restrictions constrain the remote interface, not the underlying socket. Keep its program, allowlist, home, SSH keys and sshd configuration root-owned and unwritable by the account. Never reuse its key for an unrestricted login; do not give the main application a general SSH key or Docker group membership. No sudo rights or root login are needed for runtime queries. Future isolation/Engine authorization policies could further reduce this residual privilege.

Python standard-library parsing, fixed paths/methods, strict schemas, pinned SSH identity, process CPU/address-space/fd/core limits, per-host file-lock admission and deadlines reduce attack surface; they are not a formal security audit. Review changes before upgrading the adapter. Removing a source from the host allowlist revokes it even if a browser mapping still exists.

## Optional setup on one or more hosts

Netdata discovering a new container does not grant log access. Add an exact source selector to that host's root-managed allowlist and associate it with the container or service in **Settings → Log Sources**. Compose project/service/replica selectors survive normal container replacement; a full container-ID selector must be reviewed when the container is replaced. Keep existing approvals when extending the allowlist.

Requires a Linux Docker host with Python 3, OpenSSH server, systemd, and its `docker` socket group. The installation helper targets Debian/Ubuntu’s `ssh.service`; adapt the service name on other distributions after review. Run this only on hosts whose administrator accepts the socket privilege above. It never restarts Docker or application containers.

1. On Hostboard’s deployment host, generate a dedicated key in its existing private mount. Keep ownership compatible with the application’s uid (1000 by default):

   ```sh
   install -d -m 700 private/logs
   ssh-keygen -t ed25519 -N '' -f private/logs/id_ed25519
   chmod 600 private/logs/id_ed25519
   cp config/logs.example.json private/logs.json
   ```

2. Review container identities on each Docker host using `docker inspect`. Create a root-managed source list from [log-sources.example.json](../config/log-sources.example.json). Do not include secrets, log contents or private configuration in Git. A Compose selector survives recreation only if its labels remain stable. A full container ID intentionally fails after replacement. Multiple matching replicas require separate source IDs/selectors.

3. Transfer the reviewed Hostboard source, that source list and **only the public key** to the monitored host using your existing administrative access. Install with the exact IP from which that host receives Hostboard’s SSH connections (including any container NAT):

   ```sh
   sudo ./scripts/install-log-adapter.sh /path/to/sources.json /path/to/id_ed25519.pub 192.168.1.20
   ```

   Review `/etc/hostboard-logs.json`, `/etc/ssh/sshd_config.d/90-hostboard-logs.conf`, and `/var/lib/hostboard-logs/.ssh/authorized_keys`. The installer requires an effective sshd drop-in include, verifies the resulting forced command/restrictions, validates sshd before reloading it, and creates three root-owned admission locks under `/run`. Existing SSH users keep their settings. The dedicated account must never have a writable home or an unrestricted authorized key.

4. Set `private/logs.json` to the already-configured Hostboard host IDs and **literal private/loopback addresses** of their SSH servers; optional `port` defaults to 22. Browser input cannot change these destinations. Only configure hosts that have adapters.

5. Obtain each SSH host public key through an independently trusted administrative channel (for example, read `/etc/ssh/ssh_host_ed25519_key.pub` over an already-verified SSH connection). Put `IP ssh-ed25519 BASE64` into `private/logs/known_hosts`, using `[IP]:PORT` for a nonstandard port. Do not blindly trust `ssh-keyscan` output. Keep the key files readable only as needed by the application, then recreate **only Hostboard** with the exact reviewed image. The existing private-directory mount supplies the configuration and keys; public Compose needs no added socket, capability or port.

6. Sign in as an administrator. Open Logs, confirm its source associations in Settings and inspect a short range. Test that an anonymous or non-allowlisted caller is denied. An optional diagnostic command from the application’s network namespace is:

   ```sh
   printf '%s' '{"op":"sources"}' | ssh -F /dev/null -T -o BatchMode=yes \
     -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes \
     -o UserKnownHostsFile=private/logs/known_hosts \
     -i private/logs/id_ed25519 hostboard-logs@192.168.1.10 hostboard-logs-v1
   ```

   Arbitrary commands, SFTP, forwarding and unapproved sources must fail. If a source is missing or unavailable, inspect the allowlist/unique labels, pinned host key, file ownership, `from=` source IP and Docker logging capability. Hostboard reports errors instead of fabricating entries.

Use `HOSTBOARD_LOG_CONFIG` only for an alternate deployment-owned configuration path; the `logs/` key directory is next to that file. Avoid Docker/SSH secrets in environment variables. Back up the private directory along with the database and paired image using the existing recovery process. Log mappings and audit rows are additive metadata; enabling logs does not transform observations or Netdata history. The current application uses schema 4, which older releases may refuse; restore the matching paired image/configuration/database checkpoint for rollback. To disable the feature, remove its private configuration and recreate Hostboard; revoke the authorized key/account on each host. Preserve older backup keys securely or revoke them too.

## Bounds and honest limitations

Each helper exits within eight seconds, with five CPU seconds, 192 MiB address space, 32 file descriptors, no core dumps and at most three concurrent processes per host. Hostboard allows four concurrent queries globally, kills an SSH query after ten seconds or a disconnected client, and limits log API traffic to 90 requests/minute per client. Live viewing uses the same admission limits; there are no persistent remote follow processes.

A query covers at most 24 hours and scans at most **2 MiB / 5,000 records**. Each response contains at most **500 entries / 512 KiB**, with entries capped at 16 KiB. A complete bounded scan is sorted before paging because Engine stdout/stderr multiplexing may interleave differently across reads. A scan that reaches its byte/record/deadline limit is explicitly incomplete and requires a narrower range; it does not offer an unsafe continuation cursor. Filtered searches have the same scan bound. These limits bound transfer/processing; Docker may still spend work locating historical records before the connection is closed.

The browser retains at most 2,000 entries / one million characters and visibly reports eviction. Oversized entries are truncated, invalid UTF-8 is replaced, ANSI sequences/control and bidirectional formatting characters are removed, and content is rendered as text, never HTML. TTY containers combine stdout/stderr at Docker’s source; Hostboard labels that limitation. Docker timestamps are preserved to nanoseconds; this is timestamp representation, not a claim of clock accuracy or cross-host causal ordering.

Some applications log only to internal files. Drivers/dual-logging configuration can prevent Docker reads; the helper reports actual query failures, while source metadata reports the configured driver rather than guaranteeing retained history. Rotation, deletion, retention, delayed writes and clock adjustments can affect results. Container replacement invalidates an existing cursor. A new container’s creation timestamp and the unavailable pre-creation period are shown explicitly. Source associations survive normal Compose recreation, but do not retrieve removed containers’ old logs. Historical incident records can outlive logs, and Docker cannot prove which missing entries rotated away. Hostboard guarantees no long-term log retention or automatic incident causality.

The `LogProvider` interface isolates transport/source listing/querying. systemd journals, file logs and additional backends are future providers, not part of this release. Existing Netdata journal/OTel functions do not directly read these Docker `json-file` sources; converting/collecting them would add infrastructure and change where logs live. Docker’s supported log API through the narrow helper is the v0.6 source.

## Development checks

`npm test` covers protocol validation, both administrator authentication modes, mapping generations, cancellation and incident windows. `npm run test:browser` includes Firefox desktop/mobile log interactions using controlled text fixtures. `python3 tests/log_container.py` requires local socket access and starts/removes only uniquely named test containers; it verifies actual Docker history, pagination, stream framing, follow, recreation and missing sources. `npx tsx tests/log-ssh-integration.ts` additionally builds a disposable SSH server/helper container with a socket mount, then tests the real pinned-key forced-command boundary and denials. On a development machine requiring sudo, run the Python test with `sudo -n python3` and the SSH test with `DOCKER=sudo`; never point these tests at production application logs.
