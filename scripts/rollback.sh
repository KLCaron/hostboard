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
# Preserve all current configuration and history before older code can touch SQLite.
python3 - "$root/data/monitor.sqlite" "$root/data/monitor.before-rollback-$(date -u +%Y%m%dT%H%M%SZ).sqlite" <<'PYBACKUP'
import sqlite3,sys
with sqlite3.connect(sys.argv[1]) as source,sqlite3.connect(sys.argv[2]) as destination:
    source.backup(destination)
PYBACKUP
export HOSTBOARD_TAG=$(basename "$release")
cd "$release"
docker compose --env-file "$root/.env" up -d --no-build
ln -sfn "$release" "$root/current"
echo "Restored $release. Shared .env and host configuration were preserved."
