#!/bin/sh
# Runs the Linux beachhead evidence inside a real Linux container.
#
# The repository is bind-mounted into the official Bun image; `node_modules` is
# masked by a named volume so the host's macOS-native packages never enter the
# container and the container never rewrites the host tree.
#
# Everything below also runs unchanged on a Linux host (see
# .github/workflows/linux.yml); the container exists so a macOS workstation can
# produce the same evidence.
set -eu

IMAGE="${AIRLOCK_LINUX_IMAGE:-oven/bun:1.3.13}"
VOLUME="${AIRLOCK_LINUX_MODULES_VOLUME:-airlock-linux-node-modules}"
REPOSITORY="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"

set -- docker run --rm \
  -v "${REPOSITORY}:/repo" \
  -v "${VOLUME}:/repo/node_modules" \
  -w /repo \
  -e BUN_INSTALL_CACHE_DIR=/tmp/bun-cache
if [ -n "${AIRLOCK_LINUX_PLATFORM:-}" ]; then
  set -- "$@" --platform "${AIRLOCK_LINUX_PLATFORM}"
fi
set -- "$@" "${IMAGE}" sh -euc '
  bun install --frozen-lockfile >/dev/null
  exec sh scripts/run-linux-suites.sh
'

printf 'airlock: linux evidence in %s\n' "${IMAGE}" >&2
exec "$@"
