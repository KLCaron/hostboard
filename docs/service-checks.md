# HTTP and TCP checks

Agent metrics and Docker state do not establish application availability. Add separate checks in **Settings → Services**. A running container may have an unavailable application.

Before adding a check, an operator must approve its exact destination in `private/admin.json`, then recreate Hostboard. Example policy (replace documentation addresses with your own approved destination):

```json
"targets": [
  { "host": "web.internal.example", "port": 443, "addresses": ["192.0.2.10"] },
  { "host": "192.0.2.11", "port": 22, "addresses": ["192.0.2.11"] }
]
```

A check's hostname and port must match a rule, and **all** DNS answers must be approved. Connections use the checked IP, preserving Host and TLS SNI. Metadata/link-local, unspecified, multicast and mapped IPv6 addresses are blocked even if listed. This permits explicitly approved private monitoring without giving the web application an unrestricted network-scanning interface. HTTP paths can vary on an approved origin; do not approve sensitive administrative origins unnecessarily.

HTTP checks support expected status codes, a bounded expected-content match in seed configuration, intervals, timeouts, failure thresholds and severity. HTTP redirects default to disabled. When enabled in a deployment-managed seed, redirects remain on the same origin and are revalidated; credentials never cross origins. Query strings and embedded credentials are disallowed for managed checks. TCP checks establish a connection to the approved address/port; they do not authenticate or issue application commands.

Limits: up to 100 checks including archived checks; interval 10–3600 seconds; timeout 100–30000 ms, shorter than the interval; threshold 1–20; HTTP inspection at most 1 MiB. Manual endpoint tests are administrator-only and rate limited. These are reachability checks, not vulnerability scans.

`config/checks.json` seeds the database **once**. Subsequent changes belong in Settings; replacing the seed does not overwrite existing edits/history. Archiving keeps incidents. A materially changed check retires its active incident rather than claiming a recovery. Presentation changes preserve observations. Missing samples indicate monitoring gaps rather than a fictitious success.

Advanced seed-only `headersEnv` points to an explicitly passed environment variable containing JSON headers; credentials are never exposed by the configuration API, and such a check cannot be moved to a different origin through the UI. `watchdogHistory` imports compatible independent watchdog incidents without duplicating notification ownership. These integrations remain deployment-managed. Never approve untrusted credential-bearing endpoints.

## Container resources

On current `main`, **Services → Container resources** is a searchable card grid. Each card shows the container's host, state, configured Docker health result, CPU usage, memory, and any associated independent check. Click the card or focus it and press Enter/Space to expand its image, availability details, resource investigation, and log links. CPU 100% represents one core; memory is resident MiB. Offline/stale hosts show unavailable live readings.

These are separate signals: **running** is Docker state; **healthy** is the container's configured Docker health check; **Reachable** is an independent Hostboard HTTP/TCP check. A container without a health check or application check is not assumed healthy. New containers appear when Netdata reports them; they do not automatically create service checks or log approvals. Use the target policy and Settings workflow above for application checks, and the [log-source setup](logs.md) for logs. Filtering supports container and host names, with an explicit empty result when nothing matches.

Issue acknowledgement, snoozing, and ignore rules do not turn a failing service green or resolve its incident. See [handling individual issues](operations.md#handling-individual-issues) for their effects on the active list, counts, and Hostboard emails.

## Evaluation identity and discontinued monitoring

A material evaluation change (target, host association, protocol, response criteria, schedule or threshold) starts a durable generation and retires its open incident without reporting recovery. A replacement begins with unknown availability and no last success. Name, group, notification and severity edits preserve its generation. Existing v0.5.1 observations migrate to generation 1; destinations changed before this release cannot be distinguished retroactively.

Archiving permanently discontinues monitoring: it atomically retires open incidents, suppresses outstanding outage/recovery notifications, and removes them from active-issue counts. It retains observations and incident snapshots. Restoring retains the same generation unless the evaluation changes, starts with unknown current state, and requires a fresh observation; it never turns retirement into recovery. Temporarily disabling instead keeps any confirmed incident open with a monitoring-gap marker, clears unconfirmed failure evidence, and suppresses delivery while disabled. Re-enabling can close that incident only after observed success.

`GET /api/checks/CHECK_ID/history?generation=1` reads retained availability/trends and revision boundaries for that identity, including archived checks. Local login or the normal Cloudflare Access boundary applies. A closed generation's daily window ends at its retirement boundary. Raw observations follow sample retention; incidents are retained indefinitely. The current `/api/monitor` check includes its generation number. No destination credentials are returned.

Notification retries preserve order within a check and progress independently across checks. Retry delays are 30 seconds, doubling to at most 15 minutes. Node has five delivery slots and an absolute 30-second SMTP deadline; the independent Python sender has a bounded flush, socket timeouts and a 30-second SMTP socket deadline. Stable Message-ID limits duplicate confusion, but delivery is at least once: a crash after SMTP acceptance or partial recipient rejection can cause duplicate mail. Archiving cancels in-flight Node transport where possible; a message already accepted by SMTP cannot be recalled.

Since v0.5.3, new generations also retain their original display name, host ID, protocol, HTTP origin or TCP address/port, status criteria, content-match presence, redirect/watchdog mode, interval, timeout and threshold. Boundaries and supersession reasons remain associated with the generation. HTTP paths and queries are always omitted because either can contain arbitrary secrets. Header references/values and expected-content values are omitted too. The generation number distinguishes targets sharing an origin; the sanitized snapshot does not reconstruct an exact secret-bearing URL or content rule.

`GET /api/admin/checks/CHECK_ID/history?generation=1` returns these details and the generation list under the existing administrator guard. The ordinary history read retains its existing public shape and never returns target metadata. Preexisting generations return `metadataStatus: "legacy-unavailable"` and null metadata on administrative reads; no definitions are inferred from current configuration.
