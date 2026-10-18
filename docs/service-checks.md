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
