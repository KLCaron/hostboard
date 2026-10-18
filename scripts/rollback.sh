#!/usr/bin/env bash
set -euo pipefail
umask 077
# Run ON the deployment server. Optional argument is a release directory name.
root=/srv/stacks/hostboard
if [[ $# -gt 0 ]]; then
  [[ "$1" =~ ^[a-zA-Z0-9_-]+$ ]] || { echo 'Invalid release name' >&2; exit 1; }
  release="$root/releases/$1"
else
  release=$(cat "$root/previous-release")
fi
[[ -d "$release" && "$release" == "$root/releases/"* ]] || { echo 'Previous release not found' >&2; exit 1; }
# Only schema v1 is verified with v0.4.1/v0.5.0/v0.5.1. A future migration must use
# a paired pre-upgrade database; never blindly open it with older code.
python3 - "$root/data/monitor.sqlite" "$release/package.json" <<'PYSCHEMA'
import sqlite3,sys,json
if json.load(open(sys.argv[2])).get('version') not in ['0.4.1','0.5.0','0.5.1']:
    raise SystemExit('Selected release requires a paired database/image restore')
with sqlite3.connect(sys.argv[1]) as db:
    if db.execute('PRAGMA user_version').fetchone()[0] != 1:
        raise SystemExit('Use a paired database/image restore for this schema')
PYSCHEMA
# Preserve all current configuration and history before older code can touch SQLite.
python3 - "$root/data/monitor.sqlite" "$root/data/monitor.before-rollback-$(date -u +%Y%m%dT%H%M%SZ).sqlite" <<'PYBACKUP'
import sqlite3,sys
with sqlite3.connect(sys.argv[1]) as source,sqlite3.connect(sys.argv[2]) as destination:
    source.backup(destination)
PYBACKUP
export HOSTBOARD_TAG=$(basename "$release")
cd "$release"
if [[ -f deploy/compose.host.yaml ]]; then
  docker compose -f deploy/compose.host.yaml --project-directory . --env-file "$root/.env" up -d --no-build
else
  docker compose --env-file "$root/.env" up -d --no-build
fi
ln -sfn "$release" "$root/current"
echo "Restored $release. Shared .env and host configuration were preserved."
