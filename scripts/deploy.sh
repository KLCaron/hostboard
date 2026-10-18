#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
target=${1:?Usage: scripts/deploy.sh SSH_HOST}
[[ "$target" =~ ^[a-zA-Z0-9._-]+$ ]] || { echo 'Use an SSH host alias.' >&2; exit 1; }
ssh_args=()
if [[ -f "${SSH_CONFIG:-$HOME/.ssh/config}" ]]; then ssh_args=(-F "${SSH_CONFIG:-$HOME/.ssh/config}"); fi
expected=${HOSTBOARD_EXPECT_HOSTNAME:-$target}
actual=$(ssh "${ssh_args[@]}" "$target" hostname)
[[ "$actual" == "$expected" ]] || { echo "Host identity mismatch: expected $expected, got $actual" >&2; exit 1; }
[[ -f config/hosts.json && -f .env ]] || { echo 'Create config/hosts.json and .env first; see README.' >&2; exit 1; }
[[ -f config/checks.json ]] || printf '{"checks":[]}\n' > config/checks.json
npm test
npm run build
npm run test:browser
release="$(date -u +%Y%m%dT%H%M%SZ)-$(git rev-parse --short HEAD)"
root=/srv/stacks/hostboard
ssh "${ssh_args[@]}" "$target" "set -eu; if [ ! -d '$root' ]; then sudo -n install -d -o \"\$(id -un)\" -g \"\$(id -gn)\" '$root'; fi; mkdir -p '$root/releases/$release' '$root/config'; if [ -f '$root/.env' ]; then cp '$root/.env' '$root/.env.before-$release'; fi; if [ -f '$root/config/hosts.json' ]; then cp '$root/config/hosts.json' '$root/config/hosts.json.before-$release'; fi"
# Only project source is transferred; local research, credentials and Git stay local.
tar -czf - .dockerignore Dockerfile compose.yaml package.json package-lock.json tsconfig.json tsconfig.server.json vite.config.ts index.html public src server tests scripts deploy playwright.config.ts README.md LICENSE THIRD_PARTY_NOTICES.txt config/hosts.example.json config/checks.example.json config/smtp.example.json config/admin.example.json | ssh "${ssh_args[@]}" "$target" "tar -xzf - -C '$root/releases/$release'"
ssh "${ssh_args[@]}" "$target" "test -f '$root/.env'" || scp "${ssh_args[@]}" .env "$target:$root/.env"
ssh "${ssh_args[@]}" "$target" "test -f '$root/config/hosts.json'" || scp "${ssh_args[@]}" config/hosts.json "$target:$root/config/hosts.json"
ssh "${ssh_args[@]}" "$target" "if [ -f '$root/config/checks.json' ]; then cp '$root/config/checks.json' '$root/config/checks.json.before-$release'; fi"
ssh "${ssh_args[@]}" "$target" "test -f '$root/config/checks.json'" || scp "${ssh_args[@]}" config/checks.json "$target:$root/config/checks.json"
ssh "${ssh_args[@]}" "$target" "bash -s" -- "$release" <<'REMOTE'
set -euo pipefail
release=$1
root=/srv/stacks/hostboard
chmod 600 "$root/.env"
# The app runs as uid 1000 inside Docker, so host config must be readable by it.
chmod 644 "$root/config/hosts.json"
chmod 600 "$root/config/checks.json"
install -d -m 700 "$root/data" "$root/private"
# Shared bind mounts preserve SQLite and credentials across releases and rollbacks.
ln -s "$root/data" "$root/releases/$release/data"
ln -s "$root/private" "$root/releases/$release/private"
ln -s "$root/config/checks.json" "$root/releases/$release/config/checks.json"
if [ -f "$root/data/monitor.sqlite" ]; then
  python3 - "$root/data/monitor.sqlite" "$root/data/monitor.before-$release.sqlite" <<'PY'
import sqlite3, sys
with sqlite3.connect(sys.argv[1]) as source, sqlite3.connect(sys.argv[2]) as destination:
    source.backup(destination)
PY
fi
ln -s "$root/config/hosts.json" "$root/releases/$release/config/hosts.json"
if [ -L "$root/current" ]; then readlink "$root/current" > "$root/previous-release"; fi
cd "$root/releases/$release"
export HOSTBOARD_TAG="$release"
docker compose -f deploy/compose.host.yaml --project-directory . --env-file "$root/.env" build
docker compose -f deploy/compose.host.yaml --project-directory . --env-file "$root/.env" up -d --no-build
# Verify the actual HTTP listener before advancing current.
set -a
source "$root/.env"
set +a
for attempt in $(seq 1 30); do
  if curl --fail --silent "http://$HOSTBOARD_BIND:${HOSTBOARD_PORT:-8088}/api/health" > /dev/null && curl --fail --silent "http://$HOSTBOARD_BIND:${HOSTBOARD_PORT:-8088}/api/monitor-health" > /dev/null; then
    ln -sfn "$root/releases/$release" "$root/current"
    printf '\nHostboard deployed: http://%s:%s\nRelease: %s\n' "$HOSTBOARD_BIND" "${HOSTBOARD_PORT:-8088}" "$release"
    exit 0
  fi
  sleep 2
done
if [ -f "$root/previous-release" ]; then
  previous=$(cat "$root/previous-release")
  if [ -d "$previous" ]; then
    cd "$previous"
    if [ -f deploy/compose.host.yaml ]; then
      HOSTBOARD_TAG=$(basename "$previous") docker compose -f deploy/compose.host.yaml --project-directory . --env-file "$root/.env" up -d --no-build
    else
      HOSTBOARD_TAG=$(basename "$previous") docker compose --env-file "$root/.env" up -d --no-build
    fi
  fi
fi
echo 'Deployment health check failed; previous image was restored when available.' >&2
exit 1
REMOTE
