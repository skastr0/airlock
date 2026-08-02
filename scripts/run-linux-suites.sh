#!/bin/sh
# The Linux evidence itself: one boundary proof plus the portable suites.
#
# Invoked by `scripts/prove-linux-boundary.sh` inside a container and by the
# ubuntu CI job directly, so both run byte-identical commands.
#
# Vitest must execute on the Bun runtime: the Linux lease and the atomic
# no-replace rename are Bun FFI calls, and a Node worker cannot make them.
# `--bun` pins that even on a host where Node is installed and would otherwise
# win the shebang.
set -eu

if [ "$(uname -s)" != "Linux" ]; then
  printf 'airlock: these suites require Linux, not %s\n' "$(uname -s)" >&2
  exit 2
fi

TIMEOUTS="--testTimeout 60000 --hookTimeout 60000"

printf '\n== renameat2 + flock boundary, 16-process contention, lease recovery ==\n'
bun scripts/prove-linux-boundary.ts

printf '\n== portable suites ==\n'
# shellcheck disable=SC2086
bun --bun x vitest run \
  test/exclusive-rename.test.ts \
  test/exclusive-file-lock.test.ts \
  test/hold.test.ts \
  test/outbox-hardening.test.ts \
  test/outbox-ledger-recovery.test.ts \
  test/runtime-execution-claim.test.ts \
  test/cancellation-durability.test.ts \
  ${TIMEOUTS}

# Two named exclusions, both fixture limits rather than Airlock behaviour:
#
# - Outbox "does not recover a live commit …" hangs in its own HTTP fixture
#   teardown under the Bun runtime. It reproduces identically on macOS under
#   `bun --bun x vitest`, where no Linux code runs.
# - Ledger "waits for a kernel lease held by another process …" spawns a
#   blocker that hardcodes Darwin's O_EXLOCK, which Linux does not have. The
#   Linux equivalent is proved by scripts/prove-linux-boundary.ts.
printf '\n== partially portable suites (two fixture-limited tests excluded) ==\n'
# shellcheck disable=SC2086
bun --bun x vitest run \
  test/outbox.test.ts \
  test/ledger.test.ts \
  -t '^(?!.*(does not recover a live commit from another Airlock process as uncertain|waits for a kernel lease held by another process before appending)).*' \
  ${TIMEOUTS}
