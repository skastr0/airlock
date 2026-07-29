#!/bin/sh
# Installation glue for the two verified macOS Airlock executables. This is
# deliberately release glue: it has no authority over Airlock state and never
# unlinks a live binary. Replacement and rollback preserve prior binaries in
# a unique Trash transaction directory.
set -eu

usage() {
  cat <<'EOF'
usage: scripts/install-macos.sh [options]

Install verified airlock and airlock-agent executables into PREFIX/bin.

Options:
  --source PATH       supervisor executable (default: ./dist/airlock)
  --agent-source PATH agent executable (default: sibling airlock-agent)
  --checksum PATH     SHA-256 manifest (default: sibling airlock.sha256)
  --prefix PATH       install prefix (default: $HOME/.local)
  --replace           preserve existing pair in Trash before installation
  --skip-doctor       do not invoke `airlock doctor` after installation
  --help              show this help

Both candidates are checksum-verified and probed before either live binary is
displaced. This installer performs local ad-hoc verification only; it does not
notarize or publish a release.
EOF
}

SOURCE="$(pwd)/dist/airlock"
AGENT_SOURCE=""
CHECKSUM=""
PREFIX=""
REPLACE=0
RUN_DOCTOR=1

while [ "$#" -gt 0 ]; do
  case "$1" in
    --source) SOURCE=${2:?--source requires a path}; shift 2 ;;
    --agent-source) AGENT_SOURCE=${2:?--agent-source requires a path}; shift 2 ;;
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
if [ -z "$AGENT_SOURCE" ]; then
  AGENT_SOURCE="$(dirname "$SOURCE")/airlock-agent"
fi
if [ -z "$CHECKSUM" ]; then
  CHECKSUM="$(dirname "$SOURCE")/airlock.sha256"
fi

validate_prefix() {
  candidate="$1"
  case "$candidate" in
    /*) ;;
    *) echo "airlock install: an absolute non-root --prefix is required" >&2; exit 64 ;;
  esac
  # Do not let lexical traversal, duplicate-root spellings, or a physical
  # symlink turn an apparently scoped prefix into a system directory. This
  # check deliberately runs before mkdir/cp/mv or any other filesystem write.
  case "$candidate" in
    /|//*|*/./*|*/../*|*/.|*/..)
      echo "airlock install: unsafe --prefix spelling" >&2
      exit 64
      ;;
  esac
  ancestor="$candidate"
  while [ ! -e "$ancestor" ] && [ ! -L "$ancestor" ]; do
    parent="$(dirname "$ancestor")"
    if [ "$parent" = "$ancestor" ]; then
      echo "airlock install: cannot resolve --prefix safely" >&2
      exit 64
    fi
    ancestor="$parent"
  done
  physical="$(cd -P "$ancestor" && pwd -P)"
  if [ "$physical" = "/" ]; then
    echo "airlock install: an explicit non-root --prefix is required" >&2
    exit 64
  fi
}
validate_prefix "$PREFIX"
mkdir -p "$PREFIX"
PREFIX="$(cd -P "$PREFIX" && pwd -P)"

for artifact in "$SOURCE" "$AGENT_SOURCE"; do
  if [ ! -f "$artifact" ] || [ ! -x "$artifact" ]; then
    echo "airlock install: source must be an executable file: $artifact" >&2
    exit 66
  fi
done
if [ ! -f "$CHECKSUM" ]; then
  echo "airlock install: checksum file is required: $CHECKSUM" >&2
  exit 66
fi

checksum_for() {
  awk -v name="$1" '$2 == name { print $1; exit }' "$CHECKSUM"
}
verify_source() {
  name="$1"
  path="$2"
  expected="$(checksum_for "$name")"
  actual="$(shasum -a 256 "$path" | awk '{ print $1 }')"
  if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
    echo "airlock install: checksum mismatch for $name" >&2
    exit 65
  fi
}
verify_source airlock "$SOURCE"
verify_source airlock-agent "$AGENT_SOURCE"

BIN="$PREFIX/bin"
mkdir -p "$BIN"
BIN="$(cd -P "$BIN" && pwd -P)"
TARGET="$BIN/airlock"
AGENT_TARGET="$BIN/airlock-agent"
CANDIDATE="$BIN/.airlock.installing.$$.airlock"
AGENT_CANDIDATE="$BIN/.airlock.installing.$$.airlock-agent"

if [ -e "$CANDIDATE" ] || [ -L "$CANDIDATE" ] || [ -e "$AGENT_CANDIDATE" ] || [ -L "$AGENT_CANDIDATE" ]; then
  echo "airlock install: transient candidates already exist; retry after inspection" >&2
  exit 73
fi

cp "$SOURCE" "$CANDIDATE"
cp "$AGENT_SOURCE" "$AGENT_CANDIDATE"
chmod 755 "$CANDIDATE" "$AGENT_CANDIDATE"

verify_candidate() {
  name="$1"
  candidate="$2"
  expected="$(checksum_for "$name")"
  actual="$(shasum -a 256 "$candidate" | awk '{ print $1 }')"
  if [ "$actual" != "$expected" ]; then
    echo "airlock install: copied $name checksum mismatch; preserving candidates" >&2
    exit 74
  fi
  "$candidate" --version >/dev/null
}
verify_candidate airlock "$CANDIDATE"
verify_candidate airlock-agent "$AGENT_CANDIDATE"
if [ "$RUN_DOCTOR" -eq 1 ]; then
  "$CANDIDATE" doctor >/dev/null
fi

HAS_TARGET=0
HAS_AGENT_TARGET=0
if [ -e "$TARGET" ] || [ -L "$TARGET" ]; then HAS_TARGET=1; fi
if [ -e "$AGENT_TARGET" ] || [ -L "$AGENT_TARGET" ]; then HAS_AGENT_TARGET=1; fi
if [ "$HAS_TARGET" -eq 1 ] || [ "$HAS_AGENT_TARGET" -eq 1 ]; then
  if [ "$REPLACE" -ne 1 ]; then
    echo "airlock install: destination exists; rerun with --replace" >&2
    exit 73
  fi
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
TRANSACTION="$(mktemp -d "$TRASH/.airlock.replaced.XXXXXXXX")"

rollback() {
  status=$?
  # Avoid invoking the EXIT trap again when this function exits after it has
  # restored the pair.
  trap - 0 HUP INT TERM
  if [ -e "$TARGET" ] || [ -L "$TARGET" ]; then mv "$TARGET" "$TRANSACTION/failed-airlock" || true; fi
  if [ -e "$AGENT_TARGET" ] || [ -L "$AGENT_TARGET" ]; then mv "$AGENT_TARGET" "$TRANSACTION/failed-airlock-agent" || true; fi
  if [ "$HAS_TARGET" -eq 1 ] && { [ -e "$TRANSACTION/airlock" ] || [ -L "$TRANSACTION/airlock" ]; }; then mv "$TRANSACTION/airlock" "$TARGET" || true; fi
  if [ "$HAS_AGENT_TARGET" -eq 1 ] && { [ -e "$TRANSACTION/airlock-agent" ] || [ -L "$TRANSACTION/airlock-agent" ]; }; then mv "$TRANSACTION/airlock-agent" "$AGENT_TARGET" || true; fi
  exit "$status"
}
trap rollback 0 HUP INT TERM

if [ "$HAS_TARGET" -eq 1 ] && ! mv "$TARGET" "$TRANSACTION/airlock"; then rollback; fi
if [ "$HAS_AGENT_TARGET" -eq 1 ] && ! mv "$AGENT_TARGET" "$TRANSACTION/airlock-agent"; then rollback; fi
if ! mv "$CANDIDATE" "$TARGET" || ! mv "$AGENT_CANDIDATE" "$AGENT_TARGET"; then
  rollback
fi
trap - 0 HUP INT TERM

echo "installed $TARGET"
echo "installed $AGENT_TARGET"
echo "sha256 $(checksum_for airlock)  airlock"
echo "sha256 $(checksum_for airlock-agent)  airlock-agent"
"$TARGET" --version
"$AGENT_TARGET" --version
if [ "$RUN_DOCTOR" -eq 1 ]; then "$TARGET" doctor; fi
