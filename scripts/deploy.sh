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
npm test
npm run build
release="$(date -u +%Y%m%dT%H%M%SZ)-$(git rev-parse --short HEAD)"
root=/srv/stacks/hostboard
ssh "${ssh_args[@]}" "$target" "set -eu; if [ ! -d '$root' ]; then sudo -n install -d -o \"\$(id -un)\" -g \"\$(id -gn)\" '$root'; fi; mkdir -p '$root/releases/$release' '$root/config'; if [ -f '$root/.env' ]; then cp '$root/.env' '$root/.env.before-$release'; fi; if [ -f '$root/config/hosts.json' ]; then cp '$root/config/hosts.json' '$root/config/hosts.json.before-$release'; fi"
# Only project source is transferred; local research, credentials and Git stay local.
tar -czf - .dockerignore Dockerfile compose.yaml package.json package-lock.json tsconfig.json tsconfig.server.json vite.config.ts index.html public src server tests scripts deploy playwright.config.ts README.md LICENSE config/hosts.example.json | ssh "${ssh_args[@]}" "$target" "tar -xzf - -C '$root/releases/$release'"
scp "${ssh_args[@]}" .env "$target:$root/.env"
scp "${ssh_args[@]}" config/hosts.json "$target:$root/config/hosts.json"
ssh "${ssh_args[@]}" "$target" "bash -s" -- "$release" <<'REMOTE'
set -euo pipefail
release=$1
root=/srv/stacks/hostboard
chmod 600 "$root/.env"
# The app runs as uid 1000 inside Docker, so host config must be readable by it.
chmod 644 "$root/config/hosts.json"
ln -s "$root/config/hosts.json" "$root/releases/$release/config/hosts.json"
if [ -L "$root/current" ]; then readlink "$root/current" > "$root/previous-release"; fi
cd "$root/releases/$release"
export HOSTBOARD_TAG="$release"
docker compose --env-file "$root/.env" build
docker compose --env-file "$root/.env" up -d --no-build
# Verify the actual HTTP listener before advancing current.
set -a
source "$root/.env"
set +a
for attempt in $(seq 1 30); do
  if curl --fail --silent "http://$HOSTBOARD_BIND:${HOSTBOARD_PORT:-8088}/api/health" > /dev/null; then
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
    HOSTBOARD_TAG=$(basename "$previous") docker compose --env-file "$root/.env" up -d --no-build
  fi
fi
echo 'Deployment health check failed; previous image was restored when available.' >&2
exit 1
REMOTE
