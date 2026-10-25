# Development and contributions

Use Node.js 24, npm, Python 3 and Git. Docker Compose v2 is required for the installation acceptance test.

```sh
npm ci
npm audit --audit-level=high
node scripts/check-licenses.mjs
npm run typecheck
npm test
npm run build
npm run test:reliability-integration
npm run test:logs-integration
npx playwright install --with-deps firefox
npm run test:browser
docker build -t hostboard:ci .
HOSTBOARD_TEST_IMAGE=hostboard:ci npm run test:image-browser
HOSTBOARD_TEST_IMAGE=hostboard:ci python3 tests/clean_install.py
```

The image browser check exercises real login, dashboard, administrator Settings, read-only Update Monitor, and logout against the built container with a controlled Agent, including the application security headers. On a host requiring sudo Docker access, run the Python Docker-log check as `sudo -n python3 tests/log_container.py` and the SSH check as `DOCKER=sudo npx tsx tests/log-ssh-integration.ts` instead of `npm run test:logs-integration`.

The browser runner starts an isolated backend and controlled Netdata-compatible fixture automatically; it never contacts live Agents. Clean-install acceptance clones the committed repository into a temporary directory, runs an actual Compose project with a controlled Agent and registry, exercises setup/auth/configuration/persistence/upgrade/backup/restore/failure handling, and removes its services. Commit the candidate files before this test. On a local host requiring sudo for Docker, use `DOCKER='sudo -n docker' HOSTBOARD_TEST_IMAGE=hostboard:ci python3 tests/clean_install.py`. The test forwards only its Compose/image variables through sudo.

For interactive development, run setup after `npm run build`, using `node dist/server/server/setup.js` in a separate deployment directory or copying its generated ignored configuration into your working checkout. Then run `npm run dev`. Vite serves port 5173 and proxies `/api` and `/auth` to the backend on loopback port 3001. Set the configured browser origin to `http://localhost:5173` for local form login. Prefer testing the built application (`npm start`) when validating cookie/proxy behavior.

`HOSTBOARD_TEST_URL` optionally points Playwright at a read-only acceptance environment. Never run production mutation experiments; configuration tests create their own isolated store, signed identity and SMTP fixture. Browser screenshots/traces are Git-ignored by default. Public documentation screenshots use generic fixture data.

Reuse the shared [UI interaction patterns](docs/interactions.md) for navigation, selection and disclosure controls.

Open focused PRs with a problem description and meaningful validation. Keep AGPL licensing, null/gap semantics, explicit per-node query isolation, authorization/CSRF checks, pinned monitoring targets, and recoverable database migrations. Include paired upgrade/rollback tests for schema changes. Do not introduce live infrastructure, credentials, private environment files, or AI planning/tracking documents into commits. Public user documentation belongs in Git; local development notes remain ignored.

Both required Verify jobs, **application** and **clean-install**, must pass on the final PR head before a manual merge. Do not bypass repository rules or enable automatic merging.

## Keep public documentation aligned

Before publishing a release, distinguish its published image/tag from unreleased `main` features. Review README installation/version notes, installation commands, configuration files/defaults, security guidance, migration/rollback instructions, and feature guides. Source version defaults are not proof that a registry image exists. Use the release checkout's matching helper scripts and documentation.

When changing a user workflow, update its guide and README links. Capture documentation screenshots from the built application using synthetic fixtures and generic host/container names; never publish live infrastructure or credentials. Check relative Markdown links and section anchors, and exercise documented setup commands in a disposable installation. Dated maintenance reports are historical records; their observations do not describe current repository settings indefinitely.

## Dependency maintenance

Dependencies use the committed npm lockfile. `npm audit --audit-level=high` and `node scripts/check-licenses.mjs` run in CI; new licenses require an explicit review. Regenerate `THIRD_PARTY_NOTICES.txt` with `node scripts/generate-notices.mjs` after dependency changes. `Dependabot` proposes npm, Docker base and Actions updates. Changes to CI must preserve pinned action revisions, read-only pull-request permissions, and absence of production SSH credentials.

During the development freeze, Dependabot checks weekly and proposes only routine minor/patch updates, grouped by npm production/development dependencies, with Vite and its React plugin kept together in their own group. Actions and Docker updates are grouped separately. The `allow.update-types` rules do not restrict security updates, including fixes requiring a major upgrade; keep the dependency graph, Dependabot alerts and security updates enabled in GitHub's repository settings. Every update requires review and passing Verify jobs (`application` and `clean-install`) before a manual merge; do not enable automatic merging. Node 26, Node 26 types and concurrently 10 remain deferred until active maintenance resumes. See the [freeze record](docs/maintenance-freeze-2026-10-18.md) for decisions and repository settings that need administrator verification.
