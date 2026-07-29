#!/bin/sh
# Installation glue for a verified, standalone macOS Airlock executable.
# It intentionally has no delete path: replacement and uninstall move the
# prior binary into Trash, retaining a recoverable copy outside the runtime.
set -eu

usage() {
  cat <<'EOF'
usage: scripts/install-macos.sh [options]

Install a verified Airlock executable into PREFIX/bin/airlock.

Options:
  --source PATH       executable to install (default: ./dist/airlock)
  --checksum PATH     sha256 manifest (default: SOURCE.sha256)
  --prefix PATH       install prefix (default: $HOME/.local)
  --replace           move an existing Airlock binary to Trash before install
  --skip-doctor       do not invoke `airlock doctor` after installation
  --help              show this help

The default prefix is per-user only. Existing files are never overwritten
without --replace. `uninstall-macos.sh` moves the installed binary to Trash.
EOF
}

SOURCE="$(pwd)/dist/airlock"
CHECKSUM=""
PREFIX=""
REPLACE=0
RUN_DOCTOR=1

while [ "$#" -gt 0 ]; do
  case "$1" in
    --source) SOURCE=${2:?--source requires a path}; shift 2 ;;
    --checksum) CHECKSUM=${2:?--checksum requires a path}; shift 2 ;;
    --prefix) PREFIX=${2:?--prefix requires a path}; shift 2 ;;
    --replace) REPLACE=1; shift ;;
    --skip-doctor) RUN_DOCTOR=0; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "airlock install: unknown argument: $1" >&2; usage >&2; exit 64 ;;
  esac
done

if [ -z "$PREFIX" ]; then
  if [ -z "${HOME:-}" ]; then
    echo "airlock install: HOME is unavailable; pass an explicit --prefix" >&2
    exit 78
  fi
  PREFIX="$HOME/.local"
fi

if [ -z "$CHECKSUM" ]; then
  CHECKSUM="${SOURCE}.sha256"
  if [ ! -f "$CHECKSUM" ] && [ "$(basename "$SOURCE")" = "airlock" ]; then
    CHECKSUM="$(dirname "$SOURCE")/airlock.sha256"
  fi
fi

case "$PREFIX" in
  ""|/) echo "airlock install: an explicit non-root --prefix is required" >&2; exit 64 ;;
esac

if [ ! -f "$SOURCE" ] || [ ! -x "$SOURCE" ]; then
  echo "airlock install: source must be an executable file: $SOURCE" >&2
  exit 66
fi
if [ ! -f "$CHECKSUM" ]; then
  echo "airlock install: checksum file is required: $CHECKSUM" >&2
  exit 66
fi

EXPECTED="$(awk 'NR == 1 { print $1 }' "$CHECKSUM")"
ACTUAL="$(shasum -a 256 "$SOURCE" | awk '{ print $1 }')"
if [ -z "$EXPECTED" ] || [ "$EXPECTED" != "$ACTUAL" ]; then
  echo "airlock install: checksum mismatch for $SOURCE" >&2
  exit 65
fi

BIN="$PREFIX/bin"
TARGET="$BIN/airlock"
mkdir -p "$BIN"

if [ -e "$TARGET" ] || [ -L "$TARGET" ]; then
  if [ "$REPLACE" -ne 1 ]; then
    echo "airlock install: destination exists; rerun with --replace: $TARGET" >&2
    exit 73
  fi
  if [ -n "${AIRLOCK_TRASH_DIR:-}" ]; then
    TRASH="$AIRLOCK_TRASH_DIR"
  elif [ -n "${HOME:-}" ]; then
    TRASH="$HOME/.Trash"
  else
    echo "airlock install: HOME is unavailable; set AIRLOCK_TRASH_DIR" >&2
    exit 78
  fi
  mkdir -p "$TRASH"
  STAMP="$(date +%Y%m%dT%H%M%S)"
  mv "$TARGET" "$TRASH/airlock.replaced.$STAMP"
fi

CANDIDATE="$BIN/.airlock.installing.$$"
if [ -e "$CANDIDATE" ]; then
  echo "airlock install: transient candidate already exists: $CANDIDATE" >&2
  exit 73
fi
cp "$SOURCE" "$CANDIDATE"
chmod 755 "$CANDIDATE"
CANDIDATE_SHA="$(shasum -a 256 "$CANDIDATE" | awk '{ print $1 }')"
if [ "$CANDIDATE_SHA" != "$EXPECTED" ]; then
  echo "airlock install: copied binary checksum mismatch; preserving candidate: $CANDIDATE" >&2
  exit 74
fi
mv -n "$CANDIDATE" "$TARGET"
if [ -e "$CANDIDATE" ]; then
  echo "airlock install: destination appeared during install; preserving candidate: $CANDIDATE" >&2
  exit 73
fi

echo "installed $TARGET"
echo "sha256 $EXPECTED"
"$TARGET" --version
if [ "$RUN_DOCTOR" -eq 1 ]; then
  "$TARGET" doctor
fi
