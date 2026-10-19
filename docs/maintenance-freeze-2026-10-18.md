# Dependency maintenance before development freeze

Reviewed on 2026-10-18 (America/Denver). Scope: the six open Dependabot PRs,
dependency compatibility, and existing regression/release checks. No application
features, runtime configuration, database schema, Agent identity, or production
deployment changes are included.

## Rollback checkpoint

The clean starting revision is `c8a0453bf413b82cda5237241170e69e0ba28e1b`.
Its [Verify run](https://github.com/KLCaron/hostboard/actions/runs/39181838965)
passed. Before editing, the same revision was pushed as
[`maintenance/pre-freeze-20261018`](https://github.com/KLCaron/hostboard/tree/maintenance/pre-freeze-20261018).

A complete Git bundle was also created at
`/home/kellen/Projects/hostboard-pre-freeze-20261018.bundle`, checked with
`git bundle verify`, and assigned SHA-256
`2c81a0a351df96c3725c492970f5debe0e019bc22baf675d153ecab8a72195a3`.
The baseline passed all 70 TypeScript/Node tests and 14 Python tests locally;
its production build also passed on Node 24.22.0.

For a source rollback, check out the checkpoint in a separate worktree and run
`npm ci` and `npm run build` with Node 24. For main, revert the maintenance merge
through a checked PR. This checkpoint contains source history, not production
secrets or a live database backup. Production was neither changed nor redeployed;
any future production rollback still requires operator approval and the paired
image/configuration/database procedure in [operations](operations.md).

## PR decisions

| Original PR | Decision | Compatibility and stability assessment |
| --- | --- | --- |
| [#1: Node 26 Alpine](https://github.com/KLCaron/hostboard/pull/1) | Defer; leave open | Both current PR checks passed, but retain the pinned Node 24 LTS base. Node 26 is still Current at review time, introduces V8/Undici changes and removed APIs, and changes the runtime underneath native argon2 and SQLite. No runtime migration is needed for this freeze. Revisit with matching types and the full release checks after LTS evaluation. |
| [#2: Node 26 types](https://github.com/KLCaron/hostboard/pull/2) | Defer with #1; leave open | Application checks passed; old clean-install failure was shared test infrastructure. Retain `@types/node` 24.19.2 so checks describe the deployed Node 24 API rather than permitting Node 26-only APIs. |
| [#3: Vite 8.3.4](https://github.com/KLCaron/hostboard/pull/3) | Integrate in coordinated PR #3 | Rolldown/Oxc replace Rollup/esbuild. Hostboard has a small standard React/Tailwind configuration and no custom Babel/compiler/SSR integration to migrate. Preserve Vite 7's browser targets explicitly instead of silently raising them. |
| [#4: TypeScript 7.0.2](https://github.com/KLCaron/hostboard/pull/4) | Integrate with compatibility fix through #3 | Native compiler/platform binaries replace the old JS compiler; no stable compiler API is supplied. Hostboard uses the CLI, not a compiler API integration. Add `src/vite-env.d.ts` referencing `vite/client` to declare CSS/asset imports; retain strict checks and existing server emit settings. |
| [#5: React plugin 6.1.2](https://github.com/KLCaron/hostboard/pull/5) | Integrate with Vite 8 through #3 | Requires peer `vite ^8.0.0`; updating it alone against Vite 7 fails `npm ci`. No React Compiler or custom Babel options are enabled. Group future Vite/plugin Dependabot updates. |
| [#6: Lucide React 1.57.0](https://github.com/KLCaron/hostboard/pull/6) | Integrate in coordinated PR #3 | React 19 is supported. The v1 migration removes brand icons; Hostboard imports none of those icons. Existing exports compile and rendered navigation/interactions receive browser coverage. |

Versions are locked to the reviewed PR versions, including Lucide 1.57.0.
All production npm package versions and integrity hashes remain identical to the
checkpoint. Third-party notices were regenerated for the new build dependency
tree; all 338 locked package licenses pass the existing review gate.

The final coordinated tree preserves all four original dependency commits in its
ancestry. The jointly verified lockfile resolves their conflicts, and PR #3
carries the complete compatibility changes through the existing Verify workflow.
The other three upgrade PRs are incorporated by the same merge.

Dependabot subsequently opened [#7: concurrently 10](https://github.com/KLCaron/hostboard/pull/7).
It is outside the initial six-PR review and remains deferred; this bounded pass
retains concurrently 9.2.5.

## Shared CI failures and corrections

- PRs #2, #3, and #6 failed the same `assert status['incidents']` in their old
  clean-install jobs. The monitor reported `Destination denied or DNS unavailable
  under monitoring policy` after Docker stopped the fixture and removed its DNS
  record. This was not three independent dependency regressions. Main already
  contains `5da03d2`, which checks the explicitly approved fixture IP; the
  maintenance branch retains that fix and all policy denials. Main also contains
  `c8a0453`, which waits for the independent Agent timeout before asserting
  offline status. No checks or security boundaries were relaxed.
- PR #5 failed installation with `ERESOLVE`: plugin 6 requires Vite 8 while the
  isolated PR retained Vite 7. Updating both in one lockfile resolves the peer
  requirement without `--force` or `--legacy-peer-deps`.
- PR #4 failed with TS2882 on `./style.css`. Vite client declarations fix the
  missing asset types without disabling side-effect import validation.
- Vite 8 raises default browser targets. Explicit Chrome/Edge 107, Firefox 104,
  and Safari 16 targets preserve the existing build baseline.
- The first post-merge main run passed the application job but exposed another
  [clean-install assertion failure](https://github.com/KLCaron/hostboard/actions/runs/39187478339).
  The outage wait accepted any existing historical incident, then rollback
  compared `incidents[0]` from two live responses. Those responses can contain
  different newest incidents as probes continue. The follow-up requires a
  healthy check before the outage, a fresh active incident belonging to that
  check, and the same active ID in the actual checkpoint and restored API. It
  also verifies every checkpoint incident's ID, check/generation/host association,
  onset, detection time, and original reason directly in the restored database.
  This strengthens persistence coverage without changing monitoring, backup,
  restore, or runtime code.

## Verification

Candidate commands use Node 24.22.0 and clean `npm ci`. Container acceptance uses
only disposable, uniquely named fixture projects and temporary configuration.

- `npm run typecheck` and `npm run build`: passed, including server emit.
- `npm test`: 70 TypeScript/Node tests and 14 Python tests passed, zero skipped.
- `npm run test:browser`: all 62 Firefox desktop/mobile cases passed.
- `npm run test:reliability-integration`: passed. Both watchdog authentication
  modes passed; 864,000 stored samples remained queryable while health requests
  stayed responsive (maximum measured health latency about 38 ms).
- `npm run test:logs-integration`: both components passed using the documented
  local sudo Docker access: 1,100 real Docker entries with pagination/follow,
  recreation/removal, plus pinned-key SSH forced-command and denial checks.
- `python3 tests/smtp_container.py`: verified STARTTLS/authenticated sending and
  stalled-socket cancellation in a network-isolated fixture; no real mail sent.
- `npm run test:image-browser`: passed against the built container on Firefox
  desktop/mobile: Agent dashboard, sign-in/out, administrator writes and denials.
- `npm run test:integration`: passed. Clean installation, schema-3 to schema-4
  migration with retained observations, approved Agent connection, recreation,
  incident/outage recovery, alternate private/data mounts, restrictive backup
  permissions, corrupt-restore refusal, and paired image/database rollback.
- Production Docker image builds: amd64 and arm64 passed. Runtime argon2 and
  `node:sqlite` loading passed on both architectures (Node 24.22.0).
- `npm audit --audit-level=high`: zero vulnerabilities. Trivy 0.76.0 with the
  release workflow's HIGH/CRITICAL failure threshold found zero findings in the
  amd64 image, including Alpine packages and runtime npm packages.
- `node scripts/check-licenses.mjs`, `npm ls --depth=0`, shell syntax checks,
  and Python compilation: passed. No lint script or linter configuration exists
  in this repository; no lint gate was removed or skipped.
- Targeted Vite dev-server/Fast Refresh smoke: passed; editing a React component
  updated it in Firefox while retaining its state and producing no page errors.

Critical regressions cover persisted server IDs and original GUIDs, approved
Agent moves and expiring discovery confirmations, token privacy, monitoring
gaps/incidents/notifications, metric history, configuration generations, log
source mappings, authentication/CSRF, and desktop/mobile controls.

The existing bundle-size warning also occurs on the baseline. It remains a
warning; this maintenance does not change warning thresholds or restructure the
application. No version tag, release publication, or production rollout is part
of this pass.

## Upstream review references

- [Node release status](https://nodejs.org/en/about/previous-releases) and
  [Node 26 changes](https://nodejs.org/en/blog/release/v26.0.0).
- [Vite 8 migration](https://vite.dev/guide/migration.html) and
  [React plugin changelog](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react/CHANGELOG.md).
- [TypeScript 7 announcement and compiler API limitations](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/).
- [Lucide React v1 migration](https://lucide.dev/guide/react/migration).
