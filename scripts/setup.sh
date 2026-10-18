#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
version=$(sed -n 's/^  "version": "\([^" ]*\)",$/\1/p' package.json)
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'Invalid package release version' >&2; exit 1; }
args=(--rm --user "$(id -u):$(id -g)" --volume "$PWD:/setup" --entrypoint node)
if [[ -t 0 ]]; then args+=(-it); fi
docker run "${args[@]}" "${HOSTBOARD_IMAGE:-ghcr.io/klcaron/hostboard:$version}" dist/server/server/setup.js --directory /setup "$@"
