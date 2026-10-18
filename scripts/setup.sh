#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
args=(--rm --user "$(id -u):$(id -g)" --volume "$PWD:/setup" --entrypoint node)
if [[ -t 0 ]]; then args+=(-it); fi
docker run "${args[@]}" "${HOSTBOARD_IMAGE:-ghcr.io/klcaron/hostboard:0.5.1}" dist/server/server/setup.js --directory /setup "$@"
