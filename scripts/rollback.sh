#!/usr/bin/env bash
set -euo pipefail
# Run ON the deployment server. Optional argument is a release directory name.
root=/srv/stacks/hostboard
if [[ $# -gt 0 ]]; then
  [[ "$1" =~ ^[a-zA-Z0-9_-]+$ ]] || { echo 'Invalid release name' >&2; exit 1; }
  release="$root/releases/$1"
else
  release=$(cat "$root/previous-release")
fi
[[ -d "$release" && "$release" == "$root/releases/"* ]] || { echo 'Previous release not found' >&2; exit 1; }
export HOSTBOARD_TAG=$(basename "$release")
cd "$release"
docker compose --env-file "$root/.env" up -d --no-build
ln -sfn "$release" "$root/current"
echo "Restored $release. Shared .env and host configuration were preserved."
