#!/usr/bin/env bash
# Local bridge-Compose lifecycle. Keep this script with the release's Compose file.
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
compose=(docker compose)
command=${1:-help}
backup() {
  local destination=${1:?Specify a NEW backup directory}
  [[ ! -e "$destination" ]] || { echo 'Backup destination already exists' >&2; exit 1; }
  mkdir -m 700 -p "$destination"
  destination=$(realpath "$destination")
  [[ "$destination" != "$PWD/data" && "$destination" != "$PWD/private" && "$destination" != "$PWD/config" ]] || exit 1
  python3 scripts/backup_paths.py capture "$destination"
  local stamp="$(date -u +%Y%m%dT%H%M%SZ)-$$"
  "${compose[@]}" exec -T hostboard node dist/server/server/maintenance.js backup "/app/data/backups/$stamp.sqlite"
  "${compose[@]}" exec -T hostboard cat "/app/data/backups/$stamp.sqlite" > "$destination/monitor.sqlite"
  "${compose[@]}" exec -T hostboard rm "/app/data/backups/$stamp.sqlite"
  chmod 600 "$destination/monitor.sqlite"
  "${compose[@]}" images --format json > "$destination/images.json"
  local container
  container=$("${compose[@]}" ps -q hostboard)
  docker inspect --format '{{.Config.Image}} {{.Image}}' "$container" > "$destination/image.txt"
  echo "Backup saved to $destination. It contains private configuration; store securely off-host."
}
case "$command" in
  backup) backup "${2:?Usage: scripts/manage.sh backup NEW_BACKUP_DIRECTORY}" ;;
  upgrade)
    image=${2:?Usage: scripts/manage.sh upgrade IMAGE NEW_BACKUP_DIRECTORY}
    [[ "$image" =~ ^[a-z0-9./:@_-]+$ ]] || { echo 'Invalid image reference' >&2; exit 1; }
    backup "${3:?Specify a backup directory}"
    HOSTBOARD_IMAGE="$image" "${compose[@]}" pull hostboard
    # An exact image reference is persisted, so future Compose commands use it too.
    sed -i "s|^HOSTBOARD_IMAGE=.*|HOSTBOARD_IMAGE=$image|" .env
    if ! "${compose[@]}" up -d --wait --wait-timeout 120 hostboard; then
      echo "Upgrade did not become healthy. Restore the paired image/database using scripts/manage.sh rollback '$3'." >&2
      exit 1
    fi
    ;;
  rollback)
    source_dir=$(realpath "${2:?Usage: scripts/manage.sh rollback BACKUP_DIRECTORY}")
    for file in .env monitor.sqlite image.txt; do [[ -f "$source_dir/$file" ]] || { echo "Backup missing $file" >&2; exit 1; }; done
    [[ -d "$source_dir/private" && -d "$source_dir/config" ]] || { echo 'Backup configuration missing' >&2; exit 1; }
    python3 scripts/backup_paths.py validate "$source_dir"
    backup "./backups/before-restore-$(date -u +%Y%m%dT%H%M%SZ)-$$"
    "${compose[@]}" stop hostboard
    python3 scripts/backup_paths.py restore "$source_dir"
    "${compose[@]}" run --rm --no-deps -T --entrypoint node hostboard dist/server/server/maintenance.js restore - < "$source_dir/monitor.sqlite"
    "${compose[@]}" up -d --wait --wait-timeout 120 hostboard
    ;;
  *) echo 'Usage: scripts/manage.sh backup NEW_DIR | upgrade IMAGE NEW_DIR | rollback BACKUP_DIR'; exit 1 ;;
esac
