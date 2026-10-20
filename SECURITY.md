# Security

Hostboard v0.6 receives fixes on `main`; use a current supported release. This project has undergone a practical release security review, not a formal audit or a guarantee of complete security.

For a sensitive vulnerability, use the repository's private GitHub vulnerability reporting if available, or contact the maintainer privately through their GitHub profile before disclosing exploit details. Do not post credentials, tokens, private endpoints, or backups in an issue. Public non-sensitive hardening reports can use GitHub Issues.

## Boundaries and defaults

Local mode authenticates all pages/data APIs and explicitly authorizes administrator writes. Cloudflare mode validates signed administrator JWTs and preserves private read-only access; its external Access/network policy **must** protect public reads. No arbitrary identity header grants access. No unauthenticated setup or registration interface exists. Health/scheduler status are intentionally available without login.

Local sessions are bounded, expire absolutely after one hour, use session-ID regeneration and Secure/HttpOnly/SameSite cookies on HTTPS, and disappear on restart. HTTP local login is limited to a loopback origin for local use or SSH forwarding. Administrative JSON writes enforce exact Origin and a custom request header. Login/logout forms also require per-session CSRF tokens. Do not enable permissive CORS. Reverse-proxy trust defaults to none and accepts explicit IPs only.

Only deployment-owned Agent origins and administrator-approved service host/port/IP tuples can be contacted. Per-connection DNS checks and pinned sockets prevent rebinding between validation and connection; mixed approved/unapproved DNS answers fail. Link-local/metadata, unspecified, mapped IPv6, multicast/reserved destinations are rejected. Private/loopback destinations require explicit deployment configuration and remain supported. Same-origin redirect restrictions keep authentication headers at their configured origin. There is no general-purpose URL proxy, browser-provided Agent origin, or arbitrary TCP probe API.

Containers run without root by default, with a read-only root filesystem, no capabilities, no Docker socket, no-new-privileges, resource limits, restricted temporary storage and bounded logs. The default published interface is loopback. Keep Agent APIs and data/private mounts protected. Backups include credentials and require restricted permissions and secure off-host storage. Never commit `.env`, private files, databases, or local AI/deployment notes.

SMTP requires verified TLS; transport credentials remain outside SQLite/browser APIs. Responses use generic transport errors, bounded bodies and timeouts. Security headers deny framing, external scripts and third-party connections. Rate limits bound API and sign-in traffic; manual probes and mail tests have additional limits.

Optional log retrieval always requires server-side administrator authorization, including Cloudflare deployments. A dedicated SSH key reaches only a forced-command, allowlisted Docker log reader. The main container has no Docker socket. The helper’s socket access remains root-equivalent if compromised; see the [log privilege review and setup](docs/logs.md). No raw log bodies or searches are stored in the access audit. Source listings, queries and associations are not public monitoring APIs.

## Known limitations

- Single administrator in local mode; no built-in viewer role, generic OIDC, MFA, account recovery, or distributed session store. Add a suitable Access/identity proxy if you need those features.
- Session/rate-limit state is process-local; restarting logs users out and resets those counters. Authenticated expensive requests remain a resource risk; use proxy/firewall controls for hostile public traffic. A proxy can share client rate-limit buckets.
- In Cloudflare mode, direct origin read access is trusted-network access. Do not publish it without Access protection.
- Approving an HTTP origin permits checks of its paths. Avoid approving sensitive control-plane services, and treat monitored Agents and watchdog history sources as trusted data sources.
- Agent DNS pins without explicit `addresses` reset on restart. Use explicit IP approval lists where DNS is not trusted. IPv4-mapped IPv6 and link-local scoped addresses are deliberately unsupported.
- SQLite is a single-instance local-disk design. Do not share its volume between active replicas or place it on storage without reliable SQLite locking/durability.
- Optional integration files must be syntactically valid if present. Secrets are plaintext in private files and backups; volume encryption and host access control are operator responsibilities.
- Service samples expire according to retention; incidents remain indefinitely. Browser preferences are not included in server backups. No unattended upgrades are enabled.
- The frontend build emits a size warning for its chart bundle. This affects download size, not authorization or correctness.

## Release checks

CI performs TypeScript/backend/watchdog/build tests, Firefox desktop/mobile regression tests, controlled Compose installation/recovery tests, npm vulnerability checks and a locked-dependency license review. Actions are pinned and use minimal permissions; pull requests never receive production credentials. Published images include source labels, version, digest, provenance and SBOM. The release acceptance additionally verifies deployed monitoring and a recoverable database/image checkpoint. See [dependency notes](docs/dependencies.md) and [operations](docs/operations.md).

## Update Monitor

The Update Monitor is permanently observation-only. Its administrator-only APIs read scheduled snapshots; no install, upgrade, pull, deployment, restart, arbitrary command or remote collection trigger is provided. The separate SSH reader has no Docker/sudo rights and can read only a root-owned bounded snapshot. The optional trusted local producer needs Docker daemon access; review this residual root-equivalent privilege before installing it. Registry credentials remain host-local and registry/token/CDN destinations require explicit approval. See [the complete boundary and setup](docs/updates.md).
