#!/bin/sh
# Complete Linux gate. The boundary proof reports the host primitive evidence;
# the ordinary verification gate then runs every typecheck, test, distribution
# check, shared native workload, and explicit Bun/Linux adversarial suite.
set -eu

if [ "$(uname -s)" != "Linux" ]; then
  printf 'airlock: Linux suites require Linux, not %s\n' "$(uname -s)" >&2
  exit 2
fi

printf '\n== renameat2 + flock boundary, 16-process contention, lease recovery ==\n'
bun scripts/prove-linux-boundary.ts

printf '\n== complete Linux verification gate ==\n'
bun run verify
