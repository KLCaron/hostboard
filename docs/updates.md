# Read-only Update Monitor

Open **Updates** for an attention-first grid of registered hosts. Cards show pending package names (security first), unique Compose services with changed image content, reboot flags and collection freshness. Fleet counters follow the selected server group, exclude paused hosts and include last observations; an unknown/stale count means the totals are incomplete. Collector success is displayed separately from update urgency. Choose **View details** for package versions, security classifications, repositories and per-container Compose image checks in a desktop side panel or expandable mobile card. The overview stores bounded previews (five packages and three changed services); full inventories load only when requested. Existing snapshots receive previews on application startup, without running a collector or registry check. Host metric cards link to the corresponding details. Filter using the existing server groups. Archived/disabled hosts retain their last observations but stop being polled by Hostboard. As with existing Netdata agents, the independent local producer continues until an operator disables its timer; the web application cannot manage that service. All update APIs, including summaries, require a local administrator session or a verified, allowlisted Cloudflare Access identity. Status refresh also requires Hostboard's same-origin JSON request headers.

**This feature only observes.** There are no install, upgrade, image-pull, deployment, restart, shell or execution APIs. **Refresh Status** rereads the host's latest scheduled snapshot; it does not start host collection or contact a registry. Use your separate update tools to make changes.

## Updates settings

Administrators can open **Settings → Updates** to change Hostboard's snapshot-read interval (3600–604800 seconds), freshness threshold (21600–1209600 seconds, at least the read interval), and enable or pause snapshot reads per registered host. Changes take effect without restarting Hostboard. Pausing retains observations and marks them stale; disabled/archived servers also stop reads. These settings use SQLite, the shared configuration revision, administrator authentication, same-origin JSON/CSRF checks and configuration audit. Existing `private/updates.json` timing remains the default until the GUI first saves preferences. SSH addresses, ports, node identities, keys and destination approval remain deployment-managed and cannot be changed through these APIs.

Host settings show reader configuration, last collection/receive timestamps, category status, unavailable checks caused specifically by missing registry approval, and the collector-reported registry list. The report contains exact registry hostnames and the host's package metadata freshness threshold only; it excludes credentials, token realms and redirect URLs. A stale/failed/paused reader shows the last policy observation as unverified. Older collectors remain supported but show the full registry list as **unknown**, rather than inferring permissions from successful checks. Install the matching collector through the existing local operator procedure to enable policy reports. The independent systemd timer is not inspected or controlled by the application; its documented six-hour default is not a live timer measurement.

Registry additions are **proposals**, stored separately per host. Add an exact lowercase DNS hostname and optional port, review it, remove unwanted proposals and save host preferences. Schemes, credentials, paths, IP literals, wildcards, invalid ports and duplicate proposals are rejected. Docker Hub uses the canonical `registry-1.docker.io` hostname. Format validation performs no DNS lookup or network request and does not establish that a registry is trustworthy.

**Review operator instructions** produces a host-specific identity check and a JSON merge fragment. On that host, an administrator backs up and edits the root-owned `/etc/hostboard-updates.json`, preserves existing registries/credentials, independently verifies any needed bearer-token realms and blob redirect hosts, validates JSON, and retains root:root mode 0600. Empty proposed policies contain no authentication or redirects. Wait for normal local collection and a snapshot read, then use **Reload reported status** to view the received policy. Proposals do not grant permissions. A proposal is collector-confirmed only when the host reports that exact registry; the report's timestamp and stale state remain visible. Removing a proposal never revokes active host policy. Active registry removal, credentials, auth/redirect endpoints, timer changes and collector installation remain operator-side operations.

There is deliberately no GUI Apply button, privileged helper, new SSH command or credential store. The forced-command reader remains unchanged. The Updates image detail links missing approvals directly to the relevant host's settings; unavailable checks remain separate from unchanged image results.

The additive `update_preferences` table leaves `app_settings` and schema version 4 compatible with the previous application. Older applications ignore GUI overrides and use their deployment configuration. Collector policy reports extend version-1 snapshots with an optional field accepted by the new application. **Deploy the application before the reporting collector.** When rolling back to 0.8.1, restore its paired image/config/database checkpoint and the prior collector script and snapshot on each host that was upgraded; the old strict reader does not accept the new optional field in fresh snapshots. Save those host files separately through protected operator backups. Collector code changes do not require reader, unit, timer or permission changes.

## Collection and security boundary

Netdata remains Hostboard's source of live metrics. The inspected Netdata v3 API catalog exposes reboot and Docker runtime information, but does not supply the package versions/security origins or remote image manifests needed here. The [Netdata Docker integration](https://learn.netdata.cloud/docs/collecting-metrics/collectors/containers-and-vms/docker) monitors local runtime state. This feature therefore uses a small optional Python snapshot producer and the existing deployment-owned SSH/pinned-key pattern, without introducing another listening service.

The producer runs locally from a systemd timer, normally every six hours with jitter. It reads installed APT status/existing repository lists with [python-apt's in-memory cache](https://apt-team.pages.debian.net/python-apt/library/apt.cache.html), and uses only `docker ps`, `docker info`, `docker container inspect` and `docker image inspect`. It never reads Compose files or writes package-manager state. Docker inspection can contain secrets in process memory; only selected identifiers are emitted. Raw inspection JSON and registry credentials never reach Hostboard.

A **separate unprivileged SSH reader** can read only a fixed, bounded root-owned snapshot file. It has no Docker group membership, sudo, writable home/configuration, or ability to invoke the collector. Its forced command accepts only `hostboard-updates-v1`; arguments, shell, SFTP, forwarding and other commands must be denied. A stolen reader key grants access to this inventory, not daemon access. Hostboard never mounts a Docker socket.

**Operator decision before installing:** Docker inspection requires local daemon access. The supplied producer service runs as root with an empty capability set, `NoNewPrivileges`, read-only system/home protection and a single writable snapshot directory. Docker socket access remains root-equivalent despite those restrictions: the trusted producer itself must be reviewed. Neither the web process nor the remotely reachable reader receives that access. No privileges or services are automatically installed. Keep producer/config/unit files root-owned and unwritable by both Hostboard and the reader. APT inventory can be evaluated without root; the combined service uses root for Docker access. Existing rootless Docker installations require a separately reviewed collector unit/socket environment; they are not auto-detected.

## APT semantics

Ubuntu and Debian with the distribution's `/usr/bin/python3` and `python3-apt` are supported. The collector reads `apt.Cache(memonly=True)`, installed versions and policy-selected candidates. It does not call APT update/upgrade/commit or run APT hooks. Counts describe available candidates, including held/deferred packages; they are not an upgrade dependency simulation. Packages without installed versions are excluded.

Security classification uses trusted Release origin/archive/label metadata: Ubuntu `*-security`, Debian `*-security` / `Debian-Security`. A pending security version superseded by a newer ordinary candidate is still classified as security. Package names never determine classification. Third-party/untrusted metadata without a supported advisory mapping is explicitly **unknown security**, not ordinary. Ubuntu Pro/ESM origins and other advisory providers need explicit future support. Classification is bounded by versions still present in the cache; it is not a complete CVE audit.

`/run/reboot-required` supplies the reboot flag. Absence means no flag, not proof that every running process uses current libraries. Failed/unsupported checks report unknown. Metadata age uses `/var/lib/apt/periodic/update-success-stamp`, maintained by the host's existing APT jobs. Missing, future or older-than-policy markers mean **stale/unverified**. A marker is a freshness indicator, not proof every configured repository succeeded; APT may retain older lists after a partial repository failure. A fresh zero means zero candidates in the existing cache. Stale zero never means the host is current.

The monitor deliberately performs **no repository refresh**. An isolated APT refresh would need a private lists/cache/status tree, overridden hooks, signature/expiry verification, repository credentials and strict download bounds. Reusing the host's existing APT metadata avoids that extra privileged/network surface. If operators don't already maintain metadata, stale status remains visible until their separate maintenance tools refresh it. Arch/pacman and other managers currently return unsupported; the independent package provider and versioned snapshot protocol allow later read-only providers (for example an isolated pacman database and authoritative Arch security advisories).

## Compose and registry semantics

Discovery uses the exact `com.docker.compose.project` and `com.docker.compose.service` container labels, includes stopped containers and excludes Compose one-off jobs. Each replica retains its deployed reference, immutable container ID, image config ID, repository digests and platform. Host summary counts deduplicate pending images by project/service; details show each observed replica. Projects with no remaining containers, Compose files never deployed, Swarm and non-Compose containers are outside discovery.

Registry checks fetch [OCI/Docker v2 manifests](https://specs.opencontainers.org/distribution-spec/) and image configuration JSON over verified HTTPS, without downloading layers. Multi-platform indexes select exactly one matching OS/architecture/variant; ambiguous or missing platforms are unavailable. Content-addressed manifests/configs are SHA-256 verified, and upstream config platform fields must match deployment. For Docker's classic image store, upstream and deployed image-config digests are compared. For the containerd store, the exact `ImageManifestDescriptor` recorded on the container is compared with the selected upstream platform manifest. Modern Docker image IDs can identify an OCI index: they are never assumed to be config digests. Missing platform-manifest evidence on a containerd store is unavailable, including with older CLI/API versions. This avoids comparing an index digest with either a platform manifest or a config digest. See the [Docker API changes](https://docs.docker.com/reference/api/engine/version-history/) and [containerd inspect implementation](https://github.com/moby/moby/blob/master/daemon/containerd/image_inspect.go). A changed digest means the configured moving tag now identifies different image content; it does not claim a semantic version is newer or safer. New tags/major versions are not discovered.

Digest-pinned references are **pinned**, with no moving upstream target; they are not reported as current. Images without repository digests are **local/imported**, with unavailable registry provenance. HTTP errors, unsupported auth, missing credentials, platform errors, rate limits and unapproved registries remain **unavailable**. Successful services remain visible when another fails. The last successful check time is retained for a failed check against the same deployment.

Docker Hub is the default approved registry. Other registries must be listed by their exact HTTPS hostname (and optional port) in the root-only producer configuration. There is no discovery-driven network access to arbitrary registries. For private registries, use a read-only repository-scoped credential and approved bearer-token realm, for example:

```json
"registry.example.com": {
  "username": "inventory-reader",
  "password": "REDACTED",
  "tokenRealms": ["https://registry.example.com/token"],
  "blobRedirectHosts": ["cdn.example.com"]
}
```

Only bearer challenges to exact approved HTTPS realm URLs receive credentials. The requested scope is always the inspected repository's `pull` read scope, ignoring any broader scope in the challenge. Basic-only auth, external credential helpers, Docker's `config.json`, insecure HTTP and custom TLS trust are not supported. Secrets remain in `/etc/hostboard-updates.json` (root-only); they are neither copied into the web app nor returned in errors. Docker Hub's known config-blob CDN hosts are explicit in the example. Blob-only redirects require exact approved HTTPS hostnames, at most two hops, and drop Authorization. Other redirects fail closed. Review additional CDN destinations through a trusted channel before adding them.

Checks deduplicate identical registry objects within one collection. Requests have eight-second maximum timeouts, modest pacing, at most 200 requests, a three-minute registry budget, 2 MB object bounds and 16 MB object cache. HTTP 429 stops that registry for this collection; there are no automatic retries. Docker enumeration has a four-minute budget, twelve-second command limits, 500-container and 4 MB command bounds. A five-minute process limit and systemd memory/task limits are a final backstop. Hitting a collection bound is unavailable/partial; counts are never declared complete.

## Optional host setup

This is an explicit operator-managed installation. Review the boundary above before running these steps on a monitored host. Requires OpenSSH server, systemd, Docker CLI for Docker inventory and distribution python3-apt for APT inventory. Install any missing dependencies separately using your normal maintenance tooling; Hostboard installs none.

1. On Hostboard's deployment host, generate a **new dedicated reader key** under the existing private mount:

   ```sh
   install -d -m 700 private/updates
   ssh-keygen -t ed25519 -N '' -f private/updates/id_ed25519
   chmod 600 private/updates/id_ed25519
   ```

2. Record the host's existing Hostboard registry ID and verified Netdata machine GUID from server discovery. Create a private copy of [the producer configuration](../config/update-collector.example.json), replacing both identity fields. Never use a hostname as a substitute for the registered GUID. Review the exact registry allowlist and credentials. On the monitored host, as root, provision a **new** `hostboard-updates` system user/group with home `/var/lib/hostboard-updates` and `/bin/sh` shell; disable password login (for example `useradd --system --user-group --home-dir /var/lib/hostboard-updates --shell /bin/sh --password '*' hostboard-updates`). If the account already exists, inspect it and its group memberships first. It must have no supplementary groups, Docker membership or sudo rights.

3. Install the reviewed source/configuration, units and protected directory on that host:

   ```sh
   install -d -o root -g hostboard-updates -m 750 /var/lib/hostboard-updates
   install -d -o root -g root -m 755 /usr/local/libexec
   install -o root -g root -m 755 scripts/update-collector.py /usr/local/libexec/hostboard-update-collector.py
   install -o root -g root -m 755 scripts/update-reader.py /usr/local/libexec/hostboard-update-reader.py
   install -o root -g root -m 600 /path/to/reviewed-collector.json /etc/hostboard-updates.json
   install -o root -g root -m 644 deploy/hostboard-updates.service deploy/hostboard-updates.timer /etc/systemd/system/
   install -d -o root -g root -m 755 /var/lib/hostboard-updates/.ssh
   ```

   The root producer runs with group `hostboard-updates`, writes status mode 0640 atomically, and holds a local lock. The reader cannot write the directory or status. Adjust the timer via a root-owned systemd drop-in if needed; keep collection relatively infrequent. App `intervalSeconds` controls snapshot reads independently (default 21600; minimum 3600); `staleSeconds` defaults to 86400 and must be at least the read interval.

4. Install **only the public reader key**, with the exact source IP from which this host receives Hostboard SSH traffic (including NAT), in root-owned mode-0644 `/var/lib/hostboard-updates/.ssh/authorized_keys`:

   ```text
   restrict,from="192.168.1.20",command="/usr/bin/python3 -I /usr/local/libexec/hostboard-update-reader.py" ssh-ed25519 PUBLIC_KEY
   ```

   Add a root-owned `/etc/ssh/sshd_config.d/90-hostboard-updates.conf`:

   ```text
   Match User hostboard-updates
       AuthenticationMethods publickey
       PasswordAuthentication no
       KbdInteractiveAuthentication no
       DisableForwarding yes
       PermitTTY no
       PermitUserRC no
       ForceCommand /usr/bin/python3 -I /usr/local/libexec/hostboard-update-reader.py
   Match all
   ```

   Verify `sshd -t` and `sshd -T -C user=hostboard-updates,host=localhost,addr=EXACT_SOURCE_IP` actually apply the forced command and restrictions before reloading Debian/Ubuntu's `ssh.service`. Do not alter other accounts. Enable the timer with `systemctl daemon-reload` and `systemctl enable --now hostboard-updates.timer`; the first check is scheduled after boot delay. `systemctl start hostboard-updates.service` is an operator-only one-shot collection check.

5. Obtain the host's SSH public key through an independently trusted channel. Populate `private/updates/known_hosts` with `IP ssh-ed25519 KEY`, or `[IP]:PORT` for a nonstandard port. Never blindly trust `ssh-keyscan`. Create `private/updates.json` using [the app configuration](../config/updates.example.json), with the same host ID/GUID and literal private/loopback SSH address. Web requests cannot edit this destination policy. Keep the app's private directory/key files restricted to its runtime uid. `HOSTBOARD_UPDATE_CONFIG` can select a different private config file; its sibling `updates/` directory supplies the key/known_hosts.

6. Verify the read path with the dedicated key, `-F /dev/null`, `-T`, `BatchMode=yes`, `IdentitiesOnly=yes`, `StrictHostKeyChecking=yes` and `UserKnownHostsFile=private/updates/known_hosts`, requesting only `hostboard-updates-v1`. Confirm that an arbitrary command, SFTP and forwarding fail, and the account cannot access the Docker socket or write status/configuration. Sign into Hostboard, refresh the snapshot and inspect both category states and timestamps. Test an anonymous/forged API read is denied. A host with an unverified or mismatching registered GUID cannot publish results.

## Persistence, deployment and rollback

One bounded latest JSON snapshot, compact overview, and attempt/receive/category-success timestamps are stored per stable host ID in SQLite. Overview polling returns only summaries; full inventories are read for an expanded host, keeping response memory independent of the total fleet inventory. Transport failure preserves the previous observations and success times, marks them stale, and reports the read failure. Category/registry failures preserve successful partial results. Host identity mismatches and backwards snapshot timestamps are rejected. No package history, raw Docker inspection, registry credentials or log bodies are stored. App reads are capped at four concurrent ten-second SSH operations; manual reads are limited to once per minute per host, including after restart. Update polling is separate from service probes so slow hosts cannot block existing monitoring.

The `update_snapshots` table is additive, like existing log metadata. `PRAGMA user_version` remains 4; older schema-4 images can ignore it. Existing host IDs, configuration revision and incident/sample history are untouched. Standard private/config/database backups include app settings and reader keys; producer credentials/units on each monitored host need separate protected host backups.

Before deployment, use the existing [paired image/configuration/SQLite checkpoint procedure](operations.md), preserve the exact running image, run `npm test`, `npm run build`, browser checks and installation acceptance as appropriate. Recreate only Hostboard through the installation's existing release process. No live deployment or collector installation is implied by adding this source. In particular, do not assume the running release equals the checkout version.

For rollback, restore the paired Hostboard image/config/database checkpoint using the existing lifecycle helper. To disable this feature, remove its private app configuration and restart only Hostboard; revoke its dedicated reader key and disable the optional timer on each monitored host. Existing metrics, service checks, log adapters and Docker workloads are independent. No package, container or Compose rollback is needed because the monitor never changes them.

## Validation and remaining limits

`npm test` covers snapshot schema/identity/freshness, persistence, partial failures, archive/disable behavior, rate bounds, administrator authorization/CSRF, package/security/reboot semantics, registry digest/platform/auth/network behavior, fixed reader path/ownership/command restrictions and collection bounds. Firefox desktop/mobile tests cover overview/detail navigation, version/source disclosure, stale/error states, refresh semantics and responsive layout. Live validation can stream the collector code once through an already trusted administrative connection without installing a service or creating new permissions. Keep live inventories and credentials out of Git.

Future improvements are independent read-only package providers, explicit ESM/vendor advisory mappings, stronger per-repository freshness evidence, and rootless/authorized Docker inspection. A private isolated metadata refresh could be added only after reviewing its extra surface. Remote update execution is permanently outside this feature's scope.

The 0.8.0 rollout review corrected a pre-release Docker 29 containerd-store false-positive path: an image/index ID must not be compared with an upstream config digest. Fixtures cover both storage modes and missing manifest evidence. Production onboarding must validate the exact deployed platform manifest before accepting changed-image counts.
