# Server connections and discovery

Settings → Servers lets an authenticated administrator register **already installed** Netdata Agents. Hostboard does not install Agents, scan networks, run shell commands, or change Netdata streaming. No service checks or Docker log privileges are created automatically.

1. Select **Add server** and enter a friendly name and HTTP(S) Agent origin, for example `http://agent.example.internal:19999`. Paths, queries and embedded credentials are rejected.
2. Select **Test connection**. The backend checks deployment policy before contacting the Agent.
3. If a Parent exposes several nodes, select the desired node and test again. Review the hostname, machine GUID and available metric categories.
4. Select **Save server**. Monitoring starts when enabled; no application restart is needed within the approved policy. Tests expire after ten minutes.

An existing server can be renamed, regrouped, disabled, archived or restored. Its Hostboard ID and Netdata machine GUID remain stable. Editing an origin requires another successful test of the same machine GUID. Hostname changes do not change identity. A changed GUID requires investigation; Hostboard never silently transfers history to a different machine. A physical node already registered through another Agent cannot be registered again, including while archived. Restore its original registration instead.

Disabling or archiving stops Agent requests. Archiving requires confirmation and retains the server, metadata, incident references, dashboard widget identity, service associations and log mappings. There is no destructive server deletion. Existing service checks and approved log adapters operate independently; review them separately if decommissioning a machine. Metric history is retained by Netdata, rather than copied into Hostboard. Disabled/archived registrations retain investigation references; enable the original registration to query its Agent history again.

## Operator-controlled destination approval

The registry and network trust policy are separate. Dashboard administrators cannot approve destinations, addresses, credentials or TLS exceptions.

Create `private/agents.json` using [`config/agents.example.json`](../config/agents.example.json):

```json
{
  "endpoints": [
    {"url": "http://agent.example.internal:19999", "addresses": ["10.20.0.10"]}
  ]
}
```

Approve the **exact origin** (scheme, hostname and port) and its expected literal IP addresses after checking routing and ownership. An explicit policy replaces compatibility grants; include every existing Agent origin you intend to retain. Restart only Hostboard after changing policy. `HOSTBOARD_AGENT_POLICY` overrides the path when running directly; container operators can mount the policy under `/app/private/agents.json` using the existing private directory mount. Hostboard never writes this file or operator-owned `hosts.json`.

When no explicit policy exists, only origins in the deployment-owned bootstrap `config/hosts.json` are approved. Its literal IP or `addresses` list is used. For legacy DNS entries without `addresses`, DNS answers are pinned once at application startup; an unavailable DNS name fails closed until restart. Operators should use explicit pinned addresses for durable DNS trust. Editable registry rows never create compatibility grants, even after restart. An empty bootstrap `{"hosts":[]}` supports onboarding entirely through Settings when an explicit policy is supplied.

Intentionally approved loopback, private LAN, Docker bridge and VPN destinations are supported. Private addresses are never automatically trusted based on UI input. Every request rechecks DNS answers against approved addresses and connects to the checked IP while retaining HTTP Host and TLS SNI. Mixed approved/unapproved DNS answers fail closed. IPv4/IPv6 link-local, metadata-service addresses, mapped/translation IPv6 addresses, unspecified, multicast and reserved IPv4 destinations are blocked even if listed. Agent redirects are rejected, including same-origin redirects. The backend uses fixed Netdata API paths with validated node/chart selectors; there is no generic proxy API. Service-check destinations remain separately controlled by `private/admin.json`.

## Networking and authentication

The Agent must be reachable **from the backend**. In bridge-network containers, `localhost` is the Hostboard container; `host.docker.internal` cannot reach an Agent listening only on host loopback. Use a private routable address and firewall restrictions, or the documented Linux host-network deployment. Permit only the required Agent port from the Hostboard backend. Do not expose the Agent publicly to make onboarding work. See [networking](networking.md).

HTTP and HTTPS origins work with existing deployments. HTTPS verifies the certificate and hostname; no UI option disables verification. Use a proper certificate chain or an operator-managed Node trust store. Optional `tokenEnv` in an approved policy endpoint retains the existing Bearer-token mechanism for Agents or private gateways that support it. Set that variable in the backend environment with the existing private deployment tooling; Compose operators must explicitly pass it into the container. Tokens are never entered through Settings, stored in the registry, returned by APIs, or forwarded to another origin. Hostboard does not assume every Agent requires a token or invent a new Agent authentication protocol.

Cloudflare-mode management validates the signed Access administrator allowlist, including on direct LAN access. Local mode requires a valid administrator session. Both modes require same-origin JSON requests and Hostboard’s CSRF header for mutations and connection tests. Ordinary monitoring APIs omit Agent origins, credentials, approved IPs and private transport configuration.

## Discovery, limits and diagnostics

Hostboard uses Netdata v3 nodes, contexts, data and alert APIs. It retains the established node-scoped v1 charts integration for instance labels and collector details. The v1 charts endpoint is [deprecated by Netdata](https://learn.netdata.cloud/docs/developer-and-contributor-corner/rest-api/queries); if unavailable, context discovery still works but instance-level exploration may be unavailable. Agents need compatible v3 APIs. Netdata Cloud is not an Agent origin.

Discovery records only returned values: machine GUID, node UUID, hostname, OS/kernel, CPU model/cores, physical memory, Agent version, filesystem/mount labels, interfaces, sensors, collectors and available contexts. Missing fields say “Not reported.” A collector’s presence does not imply fresh samples; current readings and freshness remain separate. Context categories cover CPU/load, memory/swap, storage, network, temperature, Docker/cgroups and pressure. Netdata alert availability is queried independently. Preferred metrics use each node’s discovered chart catalog.

Healthy chart metadata refreshes on demand every five minutes; node identity and streaming state are checked on each current-metrics poll. A streaming-state transition or failed connection triggers rediscovery on the next poll. Partial catalogs, stale samples and missing Docker coverage retry metadata within 30 seconds plus the normal polling interval. Fresh Docker dimensions without matching container labels show an unavailable count until discovery catches up. Successful discovery is cached in SQLite across restarts. Test connection explicitly rediscovers it. Failed discovery retains the previous persisted metadata with its discovery timestamp. The dashboard does not fetch every historical metric during discovery. Limits: 100 registrations including archives, 50 groups, 1,000 visible nodes per Agent, 20,000 chart instances, 10,000 contexts, 4 MiB per ordinary Agent response and 16 MiB per legacy chart catalog (at most two catalogs concurrently), three seconds for DNS and six seconds per HTTP request. Fleet responses return cached/stale placeholders after 1.5 seconds per pending host while refresh continues independently. All requests share twelve active slots and a bounded queue; each runtime Agent uses at most three slots. Interactive connection tests allow three concurrent tests and one new test per second. No external database or broker is required.

Settings and host information distinguish policy denial, refused connections, DNS failures, timeout, TLS verification, authorization failures, redirects, incompatible API responses and incorrect/duplicate identity. Missing metrics remain unavailable rather than fabricated. Test again after correcting firewall, networking, approval or Agent configuration.

## Persistence, grouping and recovery

v0.7.0 adds transactional schema **3 → 4** with `server_registry` and `server_groups`. Static hosts import once with their exact Hostboard IDs. On first successful trusted discovery, each legacy selector pins its machine GUID. Registration/group edits use the shared configuration revision and audit trail; concurrent stale saves return a conflict instead of overwriting another administrator’s work. Private policy stays outside SQLite. No operator file is overwritten.

Each server has one optional primary group. Overview and Servers remember this browser’s group filter, label group subtotals explicitly and offer **Show entire fleet**. Fleet summaries exclude archives; Servers can show archived records separately. Service, log and incident pages retain their own scope. Existing dashboard layouts survive grouping and filtering.

Back up SQLite using its backup API together with the matching image, private directory, bootstrap configuration and environment. v0.6.2 refuses schema 4. To roll back, stop only Hostboard, preserve the newer database/configuration, and restore the complete paired v0.6.2 checkpoint and saved image before starting the old version. An image-only downgrade is unsupported. See [operations](operations.md) and [installation](installation.md).
