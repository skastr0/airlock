#!/bin/sh
# Reversible pair uninstall: installed binaries move to one unique Trash
# transaction directory; no Airlock state or live binary is unlinked.
set -eu

usage() {
  cat <<'EOF'
usage: scripts/uninstall-macos.sh [--prefix PATH] [--help]

Moves PREFIX/bin/airlock and PREFIX/bin/airlock-agent to Trash. It does not
remove Airlock state; use runtime retention controls deliberately for held
recovery material.
EOF
}

PREFIX=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --prefix) PREFIX=${2:?--prefix requires a path}; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "airlock uninstall: unknown argument: $1" >&2; usage >&2; exit 64 ;;
  esac
done
if [ -z "$PREFIX" ]; then
  if [ -z "${HOME:-}" ]; then
    echo "airlock uninstall: HOME is unavailable; pass an explicit --prefix" >&2
    exit 78
  fi
  PREFIX="$HOME/.local"
fi
validate_prefix() {
  candidate="$1"
  case "$candidate" in
    /*) ;;
    *) echo "airlock uninstall: an absolute non-root --prefix is required" >&2; exit 64 ;;
  esac
  case "$candidate" in
    /|//*|*/./*|*/../*|*/.|*/..)
      echo "airlock uninstall: unsafe --prefix spelling" >&2
      exit 64
      ;;
  esac
  ancestor="$candidate"
  while [ ! -e "$ancestor" ] && [ ! -L "$ancestor" ]; do
    parent="$(dirname "$ancestor")"
    if [ "$parent" = "$ancestor" ]; then
      echo "airlock uninstall: cannot resolve --prefix safely" >&2
      exit 64
    fi
    ancestor="$parent"
  done
  physical="$(cd -P "$ancestor" && pwd -P)"
  if [ "$physical" = "/" ]; then
    echo "airlock uninstall: an explicit non-root --prefix is required" >&2
    exit 64
  fi
}
validate_prefix "$PREFIX"
if [ ! -d "$PREFIX" ]; then
  echo "airlock uninstall: no installed binary pair at $PREFIX/bin" >&2
  exit 66
fi
PREFIX="$(cd -P "$PREFIX" && pwd -P)"
TARGET="$PREFIX/bin/airlock"
AGENT_TARGET="$PREFIX/bin/airlock-agent"
if { [ ! -e "$TARGET" ] && [ ! -L "$TARGET" ]; } && { [ ! -e "$AGENT_TARGET" ] && [ ! -L "$AGENT_TARGET" ]; }; then
  echo "airlock uninstall: no installed binary pair at $PREFIX/bin" >&2
  exit 66
fi
if [ -n "${AIRLOCK_TRASH_DIR:-}" ]; then TRASH="$AIRLOCK_TRASH_DIR"
elif [ -n "${HOME:-}" ]; then TRASH="$HOME/.Trash"
else
  echo "airlock uninstall: HOME is unavailable; set AIRLOCK_TRASH_DIR" >&2
  exit 78
fi
mkdir -p "$TRASH"
TRANSACTION="$(mktemp -d "$TRASH/.airlock.uninstalled.XXXXXXXX")"
if [ -e "$TARGET" ] || [ -L "$TARGET" ]; then mv "$TARGET" "$TRANSACTION/airlock"; fi
if [ -e "$AGENT_TARGET" ] || [ -L "$AGENT_TARGET" ]; then mv "$AGENT_TARGET" "$TRANSACTION/airlock-agent"; fi
echo "moved installed Airlock binaries to $TRANSACTION"
