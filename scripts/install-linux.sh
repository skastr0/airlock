#!/bin/sh
# Transactional Linux installation glue for the two Airlock CLIs and their
# native policy launcher. All three candidates are verified and exercised
# before any installed artifact is displaced. Existing artifacts are preserved
# by same-filesystem rename for rollback and operator recovery.
set -eu

usage() {
  cat <<'EOF'
usage: scripts/install-linux.sh [options]

Install verified airlock, airlock-agent, and airlock-linux-launcher artifacts.

Options:
  --source PATH          supervisor executable (default: ./dist/airlock)
  --agent-source PATH    agent executable (default: sibling airlock-agent)
  --launcher-source PATH native launcher (default: sibling airlock-linux-launcher)
  --checksum PATH        SHA-256 list (default: sibling airlock.sha256)
  --bwrap PATH           Bubblewrap executable (default: AIRLOCK_BWRAP or PATH)
  --prefix PATH          install prefix (default: $HOME/.local)
  --replace              preserve and replace an existing installation
  --help                 show this help

The installer never downloads dependencies, grants capabilities, installs a
setuid helper, or changes AppArmor/sysctl policy. Bubblewrap 0.12.0 or newer,
libseccomp at launcher runtime, libcap's getcap utility, Landlock ABI 2+, and
working unprivileged user namespaces are mandatory and probed before activation.
EOF
}

SOURCE="$(pwd)/dist/airlock"
AGENT_SOURCE=""
LAUNCHER_SOURCE=""
CHECKSUM=""
BWRAP="${AIRLOCK_BWRAP:-}"
PREFIX=""
REPLACE=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --source) SOURCE=${2:?--source requires a path}; shift 2 ;;
    --agent-source) AGENT_SOURCE=${2:?--agent-source requires a path}; shift 2 ;;
    --launcher-source) LAUNCHER_SOURCE=${2:?--launcher-source requires a path}; shift 2 ;;
    --checksum) CHECKSUM=${2:?--checksum requires a path}; shift 2 ;;
    --bwrap) BWRAP=${2:?--bwrap requires a path}; shift 2 ;;
    --prefix) PREFIX=${2:?--prefix requires a path}; shift 2 ;;
    --replace) REPLACE=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "airlock linux install: unknown argument: $1" >&2; usage >&2; exit 64 ;;
  esac
done

if [ "$(uname -s)" != "Linux" ]; then
  echo "airlock linux install: Linux is required" >&2
  exit 69
fi
if [ -z "$PREFIX" ]; then
  if [ -z "${HOME:-}" ]; then
    echo "airlock linux install: HOME is unavailable; pass --prefix" >&2
    exit 78
  fi
  PREFIX="$HOME/.local"
fi
if [ -z "$AGENT_SOURCE" ]; then AGENT_SOURCE="$(dirname "$SOURCE")/airlock-agent"; fi
if [ -z "$LAUNCHER_SOURCE" ]; then LAUNCHER_SOURCE="$(dirname "$SOURCE")/airlock-linux-launcher"; fi
if [ -z "$CHECKSUM" ]; then CHECKSUM="$(dirname "$SOURCE")/airlock.sha256"; fi
if [ -z "$BWRAP" ]; then
  BWRAP="$(command -v bwrap 2>/dev/null || true)"
fi
if [ -z "$BWRAP" ]; then
  echo "airlock linux install: Bubblewrap 0.12.0 or newer is required" >&2
  exit 69
fi

validate_prefix() {
  candidate="$1"
  case "$candidate" in
    /*) ;;
    *) echo "airlock linux install: an absolute non-root --prefix is required" >&2; exit 64 ;;
  esac
  case "$candidate" in
    /|//*|*/./*|*/../*|*/.|*/..)
      echo "airlock linux install: unsafe --prefix spelling" >&2
      exit 64
      ;;
  esac
  ancestor="$candidate"
  while [ ! -e "$ancestor" ] && [ ! -L "$ancestor" ]; do
    parent="$(dirname "$ancestor")"
    if [ "$parent" = "$ancestor" ]; then
      echo "airlock linux install: cannot resolve --prefix safely" >&2
      exit 64
    fi
    ancestor="$parent"
  done
  physical="$(CDPATH='' cd -P "$ancestor" && pwd -P)"
  if [ "$physical" = "/" ]; then
    echo "airlock linux install: an explicit non-root --prefix is required" >&2
    exit 64
  fi
}
validate_prefix "$PREFIX"

GETCAP="$(command -v getcap 2>/dev/null || true)"
if [ -z "$GETCAP" ]; then
  for candidate in /usr/sbin/getcap /sbin/getcap /usr/bin/getcap /bin/getcap; do
    if [ -x "$candidate" ]; then GETCAP="$candidate"; break; fi
  done
fi
if [ -z "$GETCAP" ]; then
  echo "airlock linux install: libcap getcap is required" >&2
  exit 69
fi
assert_no_file_capabilities() {
  path="$1"
  if ! capabilities="$("$GETCAP" "$path" 2>/dev/null)"; then
    echo "airlock linux install: cannot inspect file capabilities: $path" >&2
    exit 69
  fi
  if [ -n "$capabilities" ]; then
    echo "airlock linux install: file capabilities are forbidden: $path" >&2
    exit 65
  fi
}

for artifact in "$SOURCE" "$AGENT_SOURCE" "$LAUNCHER_SOURCE"; do
  if [ ! -f "$artifact" ] || [ ! -x "$artifact" ] || [ -L "$artifact" ]; then
    echo "airlock linux install: source must be a regular executable, not a symlink: $artifact" >&2
    exit 66
  fi
  if [ -u "$artifact" ] || [ -g "$artifact" ]; then
    echo "airlock linux install: setuid/setgid source is forbidden: $artifact" >&2
    exit 65
  fi
  assert_no_file_capabilities "$artifact"
done
if [ ! -f "$CHECKSUM" ] || [ -L "$CHECKSUM" ]; then
  echo "airlock linux install: checksum file is required: $CHECKSUM" >&2
  exit 66
fi
if [ ! -f "$BWRAP" ] || [ ! -x "$BWRAP" ]; then
  echo "airlock linux install: Bubblewrap is not an executable file: $BWRAP" >&2
  exit 69
fi
BWRAP="$(realpath "$BWRAP")"
if [ -u "$BWRAP" ] || [ -g "$BWRAP" ]; then
  echo "airlock linux install: setuid/setgid Bubblewrap is forbidden" >&2
  exit 65
fi
assert_no_file_capabilities "$BWRAP"

checksum_for() {
  awk -v name="$1" '$2 == name { print $1 }' "$CHECKSUM"
}
verify_source() {
  name="$1"
  path="$2"
  expected="$(checksum_for "$name")"
  if ! printf '%s\n' "$expected" | grep -Eq '^[0-9a-f]{64}$'; then
    echo "airlock linux install: missing or ambiguous checksum for $name" >&2
    exit 65
  fi
  actual="$(sha256sum "$path" | awk '{ print $1 }')"
  if [ "$expected" != "$actual" ]; then
    echo "airlock linux install: checksum mismatch for $name" >&2
    exit 65
  fi
}
verify_source airlock "$SOURCE"
verify_source airlock-agent "$AGENT_SOURCE"
verify_source airlock-linux-launcher "$LAUNCHER_SOURCE"

version_output="$(env -i "$BWRAP" --version 2>/dev/null || true)"
version="$(printf '%s\n' "$version_output" | sed -n 's/^[^0-9]*\([0-9][0-9]*\)\.\([0-9][0-9]*\)\.\([0-9][0-9]*\).*/\1 \2 \3/p' | head -n 1)"
if [ -z "$version" ]; then
  echo "airlock linux install: cannot parse Bubblewrap version: $version_output" >&2
  exit 69
fi
set -- $version
if [ "$1" -lt 0 ] || { [ "$1" -eq 0 ] && [ "$2" -lt 12 ]; }; then
  echo "airlock linux install: Bubblewrap $1.$2.$3 is below required 0.12.0" >&2
  exit 69
fi

# Loading the candidate proves its ELF loader and libseccomp closure are
# available. The probe also requires Landlock ABI 2 and a loaded seccomp filter.
launcher_probe="$(env -i "$LAUNCHER_SOURCE" --probe)" || {
  echo "airlock linux install: launcher Landlock/seccomp probe failed" >&2
  exit 69
}
if ! printf '%s\n' "$launcher_probe" | grep -Eq '^airlock-linux-launcher-v1 landlock-abi=([2-9]|[1-9][0-9]+) seccomp=1$'; then
  echo "airlock linux install: unexpected launcher probe: $launcher_probe" >&2
  exit 69
fi

mkdir -p "$PREFIX"
PREFIX="$(CDPATH='' cd -P "$PREFIX" && pwd -P)"
if ! command -v flock >/dev/null 2>&1; then
  echo "airlock linux install: flock is required to serialize installation" >&2
  exit 69
fi
LOCK="$PREFIX/.airlock-install.lock"
exec 9>>"$LOCK"
flock -x 9

BIN="$PREFIX/bin"
LIBEXEC="$PREFIX/libexec/airlock"
mkdir -p "$BIN" "$LIBEXEC"
BIN="$(CDPATH='' cd -P "$BIN" && pwd -P)"
LIBEXEC="$(CDPATH='' cd -P "$LIBEXEC" && pwd -P)"
if [ "$(stat -c %d "$BIN")" != "$(stat -c %d "$LIBEXEC")" ]; then
  echo "airlock linux install: bin and libexec must share one filesystem" >&2
  exit 74
fi
TARGET="$BIN/airlock"
AGENT_TARGET="$BIN/airlock-agent"
LAUNCHER_TARGET="$LIBEXEC/airlock-linux-launcher"

has_target=0
for target in "$TARGET" "$AGENT_TARGET" "$LAUNCHER_TARGET"; do
  if [ -e "$target" ] || [ -L "$target" ]; then has_target=1; fi
done
if [ "$has_target" -eq 1 ] && [ "$REPLACE" -ne 1 ]; then
  echo "airlock linux install: destination exists; rerun with --replace" >&2
  exit 73
fi

CANDIDATE="$BIN/.airlock.installing.$$.airlock"
AGENT_CANDIDATE="$BIN/.airlock.installing.$$.airlock-agent"
LAUNCHER_CANDIDATE="$LIBEXEC/.airlock.installing.$$.airlock-linux-launcher"
for candidate in "$CANDIDATE" "$AGENT_CANDIDATE" "$LAUNCHER_CANDIDATE"; do
  if [ -e "$candidate" ] || [ -L "$candidate" ]; then
    echo "airlock linux install: transient candidate exists: $candidate" >&2
    exit 73
  fi
done
cp "$SOURCE" "$CANDIDATE"
cp "$AGENT_SOURCE" "$AGENT_CANDIDATE"
cp "$LAUNCHER_SOURCE" "$LAUNCHER_CANDIDATE"
chmod 755 "$CANDIDATE" "$AGENT_CANDIDATE" "$LAUNCHER_CANDIDATE"
verify_source airlock "$CANDIDATE"
verify_source airlock-agent "$AGENT_CANDIDATE"
verify_source airlock-linux-launcher "$LAUNCHER_CANDIDATE"
env -i "$CANDIDATE" --version >/dev/null
env -i "$AGENT_CANDIDATE" --version >/dev/null
env -i "$LAUNCHER_CANDIDATE" --probe >/dev/null

# LinuxPlatform's doctor performs the production-shaped Bubblewrap smoke test:
# exact arguments, empty bootstrap environment, launcher policy, and /bin/true.
doctor_output="$(AIRLOCK_BWRAP="$BWRAP" AIRLOCK_LINUX_LAUNCHER="$LAUNCHER_CANDIDATE" "$CANDIDATE" doctor)" || {
  echo "airlock linux install: candidate doctor failed; live installation untouched" >&2
  exit 69
}
if ! printf '%s\n' "$doctor_output" | grep -Fq '"schemaVersion": "airlock/linux-capabilities/v1"' ||
   ! printf '%s\n' "$doctor_output" | grep -Fq '"runtime": {'; then
  echo "airlock linux install: native containment is unavailable; live installation untouched" >&2
  printf '%s\n' "$doctor_output" >&2
  exit 69
fi

TRANSACTION_ROOT="$LIBEXEC/replaced"
mkdir -p "$TRANSACTION_ROOT"
TRANSACTION="$(mktemp -d "$TRANSACTION_ROOT/install.XXXXXXXX")"
MOVED_OLD_AIRLOCK=0
MOVED_OLD_AGENT=0
MOVED_OLD_LAUNCHER=0
INSTALLED_AIRLOCK=0
INSTALLED_AGENT=0
INSTALLED_LAUNCHER=0

rollback() {
  status="${1:-75}"
  trap - 0 HUP INT TERM
  if [ "$INSTALLED_AIRLOCK" -eq 1 ]; then mv "$TARGET" "$TRANSACTION/failed-airlock" || true; fi
  if [ "$INSTALLED_AGENT" -eq 1 ]; then mv "$AGENT_TARGET" "$TRANSACTION/failed-airlock-agent" || true; fi
  if [ "$INSTALLED_LAUNCHER" -eq 1 ]; then mv "$LAUNCHER_TARGET" "$TRANSACTION/failed-airlock-linux-launcher" || true; fi
  if [ "$MOVED_OLD_AIRLOCK" -eq 1 ]; then mv "$TRANSACTION/airlock" "$TARGET" || true; fi
  if [ "$MOVED_OLD_AGENT" -eq 1 ]; then mv "$TRANSACTION/airlock-agent" "$AGENT_TARGET" || true; fi
  if [ "$MOVED_OLD_LAUNCHER" -eq 1 ]; then mv "$TRANSACTION/airlock-linux-launcher" "$LAUNCHER_TARGET" || true; fi
  exit "$status"
}
trap 'status=$?; rollback "$status"' 0 HUP INT TERM

if [ -e "$TARGET" ] || [ -L "$TARGET" ]; then
  if mv "$TARGET" "$TRANSACTION/airlock"; then MOVED_OLD_AIRLOCK=1; else rollback 75; fi
fi
if [ -e "$AGENT_TARGET" ] || [ -L "$AGENT_TARGET" ]; then
  if mv "$AGENT_TARGET" "$TRANSACTION/airlock-agent"; then MOVED_OLD_AGENT=1; else rollback 75; fi
fi
if [ -e "$LAUNCHER_TARGET" ] || [ -L "$LAUNCHER_TARGET" ]; then
  if mv "$LAUNCHER_TARGET" "$TRANSACTION/airlock-linux-launcher"; then MOVED_OLD_LAUNCHER=1; else rollback 75; fi
fi
if mv "$CANDIDATE" "$TARGET"; then INSTALLED_AIRLOCK=1; else rollback 75; fi
if mv "$AGENT_CANDIDATE" "$AGENT_TARGET"; then INSTALLED_AGENT=1; else rollback 75; fi
if mv "$LAUNCHER_CANDIDATE" "$LAUNCHER_TARGET"; then INSTALLED_LAUNCHER=1; else rollback 75; fi

# Verify final relative launcher discovery, not only the staging override. A
# failure here still rolls the complete installation back.
AIRLOCK_BWRAP="$BWRAP" "$TARGET" doctor >/dev/null
trap - 0 HUP INT TERM
printf 'installed %s\ninstalled %s\ninstalled %s\n' "$TARGET" "$AGENT_TARGET" "$LAUNCHER_TARGET"
printf 'preserved transaction directory %s\n' "$TRANSACTION"
"$TARGET" --version
"$AGENT_TARGET" --version
AIRLOCK_BWRAP="$BWRAP" "$TARGET" doctor
