# Docker and Agent networking

The default Compose file uses an isolated bridge and publishes only `127.0.0.1:8088`. Change the **host-side** `HOSTBOARD_BIND` and `HOSTBOARD_PORT` in `.env` when needed. The application listens on 0.0.0.0 **inside** this container; this is enabled only by `HOSTBOARD_CONTAINER=1`. It does not publish the port on every host interface. Do not change the container listener to a host LAN address.

| Agent location | Use in `hosts.json` |
| --- | --- |
| Another physical host | Its private routable IP/hostname and Agent port |
| Same Docker network | Agent service name and container port; attach Hostboard to that network using a Compose override |
| Docker host, accepting bridge connections | `http://host.docker.internal:19999`; the default Compose file supplies the Linux host-gateway mapping |
| Docker host, bound only to 127.0.0.1 | Optional Linux host-network deployment below |
| Netdata parent receiving streams | Parent origin plus each exact child node selector |

`localhost` inside a bridge container refers to the container. `host.docker.internal` does not make a loopback-only host listener reachable. Configure the Agent listener/ACL for Hostboard's private source network, or retain a parent reachable through host networking. Do not open port 19999 to the Internet. Hostboard needs outbound HTTP(S) access to Agents, outbound connections to approved checks, and optional SMTP egress on 465/587. Cloudflare mode also needs HTTPS access to the team's signing keys.

## Optional Linux host networking

`deploy/compose.host.yaml` preserves the original deployment topology for operators with loopback-only Agents. This file builds a release image locally and uses the host network. Paths resolve against the repository root; **always** supply `--project-directory .`:

```sh
docker compose -f deploy/compose.host.yaml --project-directory . --env-file .env config --quiet
docker compose -f deploy/compose.host.yaml --project-directory . --env-file .env up -d --build --wait
```

In this mode, `HOSTBOARD_BIND` must be a literal loopback, private LAN, or supported private VPN address; wildcard/public addresses are rejected. A private IPv4 bind also opens loopback for same-host proxies. Keep the default loopback binding unless private LAN access is needed. Use the release-directory SSH deployment helpers only for this topology; see [operations](operations.md).

Agent credentials belong in an explicitly passed environment variable referenced by `tokenEnv`. Add it through a private Compose override or environment file; the default Compose file never copies arbitrary host environment variables into the container. Do not put tokens in URLs.

## DNS

Service-check policy names and port numbers must match exactly, and every DNS answer must be in the approved IP list. Agent hostnames are pinned to their first resolved address set for the process lifetime, or to optional `addresses` in the host entry. Every connection verifies current DNS answers against that set and connects to the validated address while retaining HTTP Host/TLS SNI. Use explicit Agent `addresses` for approvals that should survive restarts. After an intentional DNS/IP change, update approved addresses and recreate Hostboard. Link-local/metadata, multicast, unspecified and mapped IPv6 destinations are rejected; explicit private/loopback monitoring remains supported.

## Service endpoints that survive Docker restarts

Docker can assign different bridge IPs after a reboot. A check using a container's
current IP can then probe a different service, return a misleading 404, or fail to
connect. Retrying cannot repair an obsolete destination. Do not automatically
replace approved addresses from discovery or relax the IP policy.

For Hostboard using Linux host networking, publish a dedicated service port on
**127.0.0.1 only**, using an override in that service's Compose project:

```yaml
services:
  web:
    ports:
      - "127.0.0.1:18080:80"
```

Approve exactly `127.0.0.1:18080` in Hostboard's deployment policy and update the
existing check through Settings to `http://127.0.0.1:18080/health`. Preserve its ID,
response criteria, timing, severity and notification preferences. Changing the
destination starts a new evaluation generation; the old incident is retained with
“Check configuration changed,” rather than an invented recovery. Verify a fresh
successful observation for the replacement generation. Back up configuration and
the database first. Recreating a service to add a published port needs the service
operator's approval.

A bridge-network Hostboard needs a reachable published private interface or a
shared network with a stable service name **and operator-managed stable approved
addresses**. Docker DNS names alone do not make changing IPs safe under exact IP
allowlisting. Test from inside the actual Hostboard container. See
[service checks](service-checks.md) for authorization and generation semantics.

A streaming Child may take several minutes to retry after a Parent connection
timeout. Check its own streaming logs and the Parent's per-GUID samples before
attributing this to Hostboard. Keep the Child's persistent identity and stream
credentials; recreating its data volume is not a recovery procedure. Hostboard
cannot reconnect a Netdata stream on the Child's behalf.
