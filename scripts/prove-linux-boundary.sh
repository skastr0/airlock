#!/bin/sh
# Runs only the portable rename/flock boundary proof in an ordinary Linux
# container. Native containment deliberately is not attempted here: Docker's
# outer seccomp/AppArmor/user-namespace policy varies, and this helper never
# asks for --privileged or weakens host policy to manufacture a pass.
#
# Use scripts/run-linux-suites.sh on a Linux host for the complete required
# native-contained gate. The repository is bind-mounted here and node_modules
# is masked so host-native dependencies neither enter nor rewrite the checkout.
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
  exec bun scripts/prove-linux-boundary.ts
'

printf 'airlock: portable Linux boundary evidence in %s\n' "${IMAGE}" >&2
exec "$@"
