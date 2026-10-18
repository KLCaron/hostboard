# Administrator authentication

## Local administrator (default for new installations)

`./scripts/setup.sh` creates a single explicit account in `private/admin.json`. Passwords use the maintained `argon2` library with Argon2id (64 MiB, three iterations, one lane). No plaintext password is stored. Sessions use `express-session` and a bounded expiring `memorystore` store. The browser receives only a signed random session identifier; identity stays server-side.

All dashboard pages and monitoring/configuration APIs require login in local mode, apart from `/api/health` and `/api/monitor-health`. These expose status only for container health/watchdog integration. Login rotates the session ID. Sessions expire after one hour absolutely and are invalidated on restart or sign-out. HTTPS uses a host-only Secure/HttpOnly/SameSite=Strict cookie. HTTP sessions are allowed only for a loopback browser origin (for local use/SSH forwarding). There is no registration, password reset service, shared default password, or viewer account in this release.

Sign-in and sign-out require same-origin form requests and a per-session CSRF token. Administrative mutations require exact configured Origin, JSON content type, and `X-Hostboard-Request: 1`; CORS is disabled. Sign-in is throttled per source; concurrent password verification is bounded. API requests are also throttled. A proxy may share a rate-limit bucket unless its exact address is explicitly trusted. The app never trusts identity supplied in arbitrary proxy headers.

For a forgotten password, stop Hostboard, back up configuration/data, and generate a new local configuration using setup in a separate empty directory. Replace only `username`, `passwordHash`, and `sessionSecret` in the existing private admin file; preserve `origin`, `targets`, and proxy settings. Remove temporary configuration securely, then recreate Hostboard. This requires access to the deployment host; it cannot be done through an unauthenticated web interface.

## Cloudflare Access (existing deployments supported)

The original admin format remains valid, without a `mode` key. `mode: "cloudflare"` is also accepted. Copy [the example](../config/admin.example.json) to `private/admin.json`, then configure the exact team issuer, application audience, allowed administrator emails, HTTPS origin and target policy.

Hostboard verifies `Cf-Access-Jwt-Assertion` against the team's HTTPS JWKS endpoint using `jose`. It enforces RS256, issuer, audience, expiration, issue time, subject and email; tokens older than 24 hours fail. Only an email in the explicit allowlist can administer. Forged email headers, unsigned/expired/wrong-audience tokens and direct LAN mutations are denied.

**Cloudflare-mode read access remains protected by your network or Access proxy.** Protect every path, including `/api/*`, in the Access application. Its policies must prevent unauthenticated public access. Restrict direct origin connectivity to trusted sources. Hostboard preserves direct private read-only access for existing LAN/watchdog deployments. It does not turn an unprotected tunnel into authentication.

Configure an Access application and policy before routing the public hostname to Hostboard. Use an HTTPS browser origin that exactly matches `admin.json`. Keep tunnel credentials, audience, email allowlists and real ingress configuration private. Verify an unauthenticated request to both the root and `/api/fleet` is redirected/denied by Access, and verify a permitted account through the actual public hostname. See [Cloudflare's JWT validation documentation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/).

Cloudflare is optional. Generic OIDC and separate viewer/admin accounts are not implemented. Both modes expose the same administrator identity boundary, leaving room for future roles without a registration system.
