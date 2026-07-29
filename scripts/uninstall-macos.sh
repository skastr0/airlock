#!/bin/sh
# Reversible uninstall: Airlock itself is moved to Trash, never unlinked.
set -eu

usage() {
  cat <<'EOF'
usage: scripts/uninstall-macos.sh [--prefix PATH] [--help]

Moves PREFIX/bin/airlock to Trash. It does not remove Airlock state; use the
runtime's retention controls deliberately for held recovery material.
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

case "$PREFIX" in
  ""|/) echo "airlock uninstall: an explicit non-root --prefix is required" >&2; exit 64 ;;
esac

TARGET="$PREFIX/bin/airlock"
if [ ! -e "$TARGET" ] && [ ! -L "$TARGET" ]; then
  echo "airlock uninstall: no installed binary at $TARGET" >&2
  exit 66
fi
if [ -n "${AIRLOCK_TRASH_DIR:-}" ]; then
  TRASH="$AIRLOCK_TRASH_DIR"
elif [ -n "${HOME:-}" ]; then
  TRASH="$HOME/.Trash"
else
  echo "airlock uninstall: HOME is unavailable; set AIRLOCK_TRASH_DIR" >&2
  exit 78
fi
mkdir -p "$TRASH"
STAMP="$(date +%Y%m%dT%H%M%S)"
DESTINATION="$TRASH/airlock.uninstalled.$STAMP"
mv "$TARGET" "$DESTINATION"
echo "moved $TARGET to $DESTINATION"
