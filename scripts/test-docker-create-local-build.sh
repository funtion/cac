#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# shellcheck source=/dev/null
source "$ROOT_DIR/src/cmd_docker.sh"

docker() {
    DOCKER_ARGS=("$@")
}

cd "$ROOT_DIR"
_dk_cmd_create >/dev/null

expected=(build -f "$ROOT_DIR/docker/Dockerfile" -t "ghcr.io/nmhjklnm/cac-docker:latest" "$ROOT_DIR")
if [[ "${DOCKER_ARGS[*]}" != "${expected[*]}" ]]; then
    echo "FAIL: cac docker create should build the image locally" >&2
    echo "  expected: docker ${expected[*]}" >&2
    echo "  actual:   docker ${DOCKER_ARGS[*]}" >&2
    exit 1
fi

echo "✓ cac docker create builds the image locally"
