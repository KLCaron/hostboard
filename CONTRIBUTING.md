# Development and contributions

Use Node.js 24, npm, Python 3 and Git. Docker Compose v2 is required for the installation acceptance test.

```sh
npm ci
npm test
npm run build
npx playwright install --with-deps firefox
npm run test:browser
node scripts/check-licenses.mjs
docker build -t hostboard:ci .
HOSTBOARD_TEST_IMAGE=hostboard:ci npm run test:image-browser
HOSTBOARD_TEST_IMAGE=hostboard:ci python3 tests/clean_install.py
```

The image browser check exercises real login, dashboard, administrator Settings and logout against the built container with a controlled Agent, including the application security headers.

The browser runner starts an isolated backend and controlled Netdata-compatible fixture automatically; it never contacts live Agents. Clean-install acceptance clones the committed repository into a temporary directory, runs an actual Compose project with a controlled Agent and registry, exercises setup/auth/configuration/persistence/upgrade/backup/restore/failure handling, and removes its services. Commit the candidate files before this test. On a local host requiring sudo for Docker, use `DOCKER='sudo -n docker' HOSTBOARD_TEST_IMAGE=hostboard:ci python3 tests/clean_install.py`. The test forwards only its Compose/image variables through sudo.

For interactive development, run setup after `npm run build`, using `node dist/server/server/setup.js` in a separate deployment directory or copying its generated ignored configuration into your working checkout. Then run `npm run dev`. Vite serves port 5173 and proxies `/api` and `/auth` to the backend on loopback port 3001. Set the configured browser origin to `http://localhost:5173` for local form login. Prefer testing the built application (`npm start`) when validating cookie/proxy behavior.

`HOSTBOARD_TEST_URL` optionally points Playwright at a read-only acceptance environment. Never run production mutation experiments; configuration tests create their own isolated store, signed identity and SMTP fixture. Browser screenshots/traces are Git-ignored by default. Public documentation screenshots use generic fixture data.

Reuse the shared [UI interaction patterns](docs/interactions.md) for navigation, selection and disclosure controls.

Open focused PRs with a problem description and meaningful validation. Keep AGPL licensing, null/gap semantics, explicit per-node query isolation, authorization/CSRF checks, pinned monitoring targets, and recoverable database migrations. Include paired upgrade/rollback tests for schema changes. Do not introduce live infrastructure, credentials, private environment files, or AI planning/tracking documents into commits. Public user documentation belongs in Git; local development notes remain ignored.

Dependencies use the committed npm lockfile. `npm audit --audit-level=high` and `node scripts/check-licenses.mjs` run in CI; new licenses require an explicit review. Regenerate `THIRD_PARTY_NOTICES.txt` with `node scripts/generate-notices.mjs` after dependency changes. `Dependabot` proposes npm, Docker base and Actions updates. Changes to CI must preserve pinned action revisions, read-only pull-request permissions, and absence of production SSH credentials.
