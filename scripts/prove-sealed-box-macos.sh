#!/bin/sh
# Opt-in, privileged macOS principal proof. It publishes one immutable
# generation and intentionally performs no cleanup or rollback.
set -eu

if [ "${AIRLOCK_RUN_PRIVILEGED_PROOF:-}" != "1" ]; then
  echo "sealed-box macOS proof is opt-in; set AIRLOCK_RUN_PRIVILEGED_PROOF=1" >&2
  exit 77
fi
if [ "$(uname -s)" != "Darwin" ] || [ "$(id -u)" -ne 0 ]; then
  echo "sealed-box macOS proof requires root on Darwin" >&2
  exit 77
fi

usage() {
  echo "usage: $0 --bundle ABS --box ID --workspace ABS --agent-user USER --agent-group GROUP" >&2
  exit 64
}
BUNDLE= BOX= WORKSPACE= AGENT_USER= AGENT_GROUP=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --bundle) BUNDLE=${2:-}; shift 2 ;;
    --box) BOX=${2:-}; shift 2 ;;
    --workspace) WORKSPACE=${2:-}; shift 2 ;;
    --agent-user) AGENT_USER=${2:-}; shift 2 ;;
    --agent-group) AGENT_GROUP=${2:-}; shift 2 ;;
    *) usage ;;
  esac
done
[ -n "$BUNDLE" ] && [ -n "$BOX" ] && [ -n "$WORKSPACE" ] && \
  [ -n "$AGENT_USER" ] && [ -n "$AGENT_GROUP" ] || usage
case "$BUNDLE:$WORKSPACE" in /*:/*) ;; *) usage ;; esac
AGENT_UID=$(id -u "$AGENT_USER")
AGENT_GID=$(dscl . -read "/Groups/$AGENT_GROUP" PrimaryGroupID | awk '{print $2}')

INSTALL=$(bun scripts/seal-box.ts install \
  --bundle "$BUNDLE" --root / --box "$BOX" --workspace "$WORKSPACE" \
  --agent-user "$AGENT_USER" --agent-uid "$AGENT_UID" \
  --agent-group "$AGENT_GROUP" --agent-gid "$AGENT_GID" \
  --apply-ownership)
GENERATION=$(printf '%s' "$INSTALL" | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin)["generation"])')
PLIST=$(printf '%s' "$INSTALL" | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin)["launchd"])')
LABEL="com.airlock.box.$BOX"

/bin/launchctl bootstrap system "$PLIST"
for _ in $(jot 100); do
  if [ -S "$GENERATION/ipc/daemon.sock" ]; then break; fi
  sleep 0.05
done
[ -S "$GENERATION/ipc/daemon.sock" ] || {
  /bin/launchctl print "system/$LABEL" >&2 || true
  echo "daemon socket did not become ready" >&2
  exit 75
}

AGENT="$GENERATION/bin/airlock-agent"
/usr/bin/sudo -u "$AGENT_USER" /usr/bin/env AIRLOCK_AGENT_SURFACE=1 \
  "$AGENT" eval --workspace "$WORKSPACE" --source 'return true'
/usr/bin/sudo -u "$AGENT_USER" /usr/bin/env AIRLOCK_AGENT_SURFACE=1 \
  "$AGENT" held
/usr/bin/sudo -u "$AGENT_USER" /usr/bin/env AIRLOCK_AGENT_SURFACE=1 \
  "$AGENT" pending

printf '{"proof":"sealed-box-macos-two-principal","generation":"%s","daemon_uid":0,"agent_uid":%s,"activated":true}\n' \
  "$GENERATION" "$AGENT_UID"
