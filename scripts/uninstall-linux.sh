#!/bin/sh
# Reversible Linux uninstall. The two CLIs and native launcher move into one
# same-filesystem transaction directory; Airlock state and retained Holds are
# not touched.
set -eu

usage() {
  cat <<'EOF'
usage: scripts/uninstall-linux.sh [--prefix PATH] [--help]

Moves PREFIX/bin/airlock, PREFIX/bin/airlock-agent, and the Linux launcher to a
preserved transaction directory under PREFIX/libexec/airlock/replaced.
EOF
}

PREFIX=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --prefix) PREFIX=${2:?--prefix requires a path}; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "airlock linux uninstall: unknown argument: $1" >&2; usage >&2; exit 64 ;;
  esac
done
if [ "$(uname -s)" != "Linux" ]; then
  echo "airlock linux uninstall: Linux is required" >&2
  exit 69
fi
if [ -z "$PREFIX" ]; then
  if [ -z "${HOME:-}" ]; then
    echo "airlock linux uninstall: HOME is unavailable; pass --prefix" >&2
    exit 78
  fi
  PREFIX="$HOME/.local"
fi

validate_prefix() {
  candidate="$1"
  case "$candidate" in
    /*) ;;
    *) echo "airlock linux uninstall: an absolute non-root --prefix is required" >&2; exit 64 ;;
  esac
  case "$candidate" in
    /|//*|*/./*|*/../*|*/.|*/..)
      echo "airlock linux uninstall: unsafe --prefix spelling" >&2
      exit 64
      ;;
  esac
  ancestor="$candidate"
  while [ ! -e "$ancestor" ] && [ ! -L "$ancestor" ]; do
    parent="$(dirname "$ancestor")"
    if [ "$parent" = "$ancestor" ]; then
      echo "airlock linux uninstall: cannot resolve --prefix safely" >&2
      exit 64
    fi
    ancestor="$parent"
  done
  physical="$(CDPATH='' cd -P "$ancestor" && pwd -P)"
  if [ "$physical" = "/" ]; then
    echo "airlock linux uninstall: an explicit non-root --prefix is required" >&2
    exit 64
  fi
}
validate_prefix "$PREFIX"
if [ ! -d "$PREFIX" ]; then
  echo "airlock linux uninstall: no installation at $PREFIX" >&2
  exit 66
fi
PREFIX="$(CDPATH='' cd -P "$PREFIX" && pwd -P)"
if ! command -v flock >/dev/null 2>&1; then
  echo "airlock linux uninstall: flock is required" >&2
  exit 69
fi
LOCK="$PREFIX/.airlock-install.lock"
exec 9>>"$LOCK"
flock -x 9

BIN="$PREFIX/bin"
LIBEXEC="$PREFIX/libexec/airlock"
TARGET="$BIN/airlock"
AGENT_TARGET="$BIN/airlock-agent"
LAUNCHER_TARGET="$LIBEXEC/airlock-linux-launcher"
found=0
for target in "$TARGET" "$AGENT_TARGET" "$LAUNCHER_TARGET"; do
  if [ -e "$target" ] || [ -L "$target" ]; then found=1; fi
done
if [ "$found" -ne 1 ]; then
  echo "airlock linux uninstall: no installed artifacts at $PREFIX" >&2
  exit 66
fi
if [ ! -d "$BIN" ] || [ ! -d "$LIBEXEC" ] ||
   [ "$(stat -c %d "$BIN")" != "$(stat -c %d "$LIBEXEC")" ]; then
  echo "airlock linux uninstall: bin and libexec must share one filesystem" >&2
  exit 74
fi

TRANSACTION_ROOT="$LIBEXEC/replaced"
mkdir -p "$TRANSACTION_ROOT"
TRANSACTION="$(mktemp -d "$TRANSACTION_ROOT/uninstall.XXXXXXXX")"
MOVED_AIRLOCK=0
MOVED_AGENT=0
MOVED_LAUNCHER=0

rollback() {
  status="${1:-75}"
  trap - 0 HUP INT TERM
  recovery_failed=0
  if [ "$MOVED_AIRLOCK" -eq 1 ] && ! mv "$TRANSACTION/airlock" "$TARGET"; then
    echo "airlock linux uninstall: recover $TRANSACTION/airlock to $TARGET" >&2
    recovery_failed=1
  fi
  if [ "$MOVED_AGENT" -eq 1 ] && ! mv "$TRANSACTION/airlock-agent" "$AGENT_TARGET"; then
    echo "airlock linux uninstall: recover $TRANSACTION/airlock-agent to $AGENT_TARGET" >&2
    recovery_failed=1
  fi
  if [ "$MOVED_LAUNCHER" -eq 1 ] && ! mv "$TRANSACTION/airlock-linux-launcher" "$LAUNCHER_TARGET"; then
    echo "airlock linux uninstall: recover $TRANSACTION/airlock-linux-launcher to $LAUNCHER_TARGET" >&2
    recovery_failed=1
  fi
  if [ "$recovery_failed" -eq 1 ]; then exit 76; fi
  exit "$status"
}
trap 'status=$?; rollback "$status"' 0 HUP INT TERM

if [ -e "$TARGET" ] || [ -L "$TARGET" ]; then
  if mv "$TARGET" "$TRANSACTION/airlock"; then MOVED_AIRLOCK=1; else rollback 75; fi
fi
if [ -e "$AGENT_TARGET" ] || [ -L "$AGENT_TARGET" ]; then
  if mv "$AGENT_TARGET" "$TRANSACTION/airlock-agent"; then MOVED_AGENT=1; else rollback 75; fi
fi
if [ -e "$LAUNCHER_TARGET" ] || [ -L "$LAUNCHER_TARGET" ]; then
  if mv "$LAUNCHER_TARGET" "$TRANSACTION/airlock-linux-launcher"; then MOVED_LAUNCHER=1; else rollback 75; fi
fi
trap - 0 HUP INT TERM
printf 'moved installed Airlock artifacts to %s\n' "$TRANSACTION"
