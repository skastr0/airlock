#!/bin/sh
# Build the native Linux policy launcher. This is build glue: it refuses to
# replace an existing output and publishes only a launcher that passes its own
# Landlock/seccomp probe.
set -eu

usage() {
  echo "usage: scripts/build-linux-launcher.sh [output]"
}

case "${1:-}" in
  --help|-h) usage; exit 0 ;;
  -*) echo "airlock linux launcher: unknown option: $1" >&2; usage >&2; exit 64 ;;
esac
if [ "$#" -gt 1 ]; then
  echo "airlock linux launcher: expected at most one output path" >&2
  usage >&2
  exit 64
fi
if [ "$(uname -s)" != "Linux" ]; then
  echo "airlock linux launcher: build requires Linux" >&2
  exit 2
fi

OUTPUT=${1:-dist/airlock-linux-launcher}
SOURCE=${AIRLOCK_LINUX_LAUNCHER_SOURCE:-src/platform/linux/native/airlock-linux-launcher.c}

if [ -e "$OUTPUT" ] || [ -L "$OUTPUT" ]; then
  echo "airlock linux launcher: refusing to replace existing artifact: $OUTPUT" >&2
  exit 73
fi
if [ ! -f "$SOURCE" ]; then
  echo "airlock linux launcher: source is unavailable: $SOURCE" >&2
  exit 66
fi
if ! command -v cc >/dev/null 2>&1; then
  echo "airlock linux launcher: cc is required" >&2
  exit 69
fi
if ! command -v pkg-config >/dev/null 2>&1 || ! pkg-config --exists libseccomp; then
  echo "airlock linux launcher: libseccomp development files and pkg-config are required" >&2
  exit 69
fi

PARENT=$(dirname "$OUTPUT")
mkdir -p "$PARENT"
CANDIDATE="$OUTPUT.building.$$"
if [ -e "$CANDIDATE" ] || [ -L "$CANDIDATE" ]; then
  echo "airlock linux launcher: transient candidate already exists: $CANDIDATE" >&2
  exit 73
fi

# pkg-config emits compiler/linker atoms; libseccomp's supported flags contain
# no shell metacharacters. Word splitting here is intentional and isolated to
# trusted build metadata.
# shellcheck disable=SC2046
cc \
  -std=c11 -O2 \
  -Wall -Wextra -Werror -Wconversion -Wformat=2 \
  -D_FORTIFY_SOURCE=2 -fstack-protector-strong \
  -fPIE -pie -Wl,-z,relro,-z,now \
  $(pkg-config --cflags libseccomp) \
  "$SOURCE" -o "$CANDIDATE" \
  $(pkg-config --libs libseccomp)
chmod 755 "$CANDIDATE"
"$CANDIDATE" --probe >/dev/null

# OUTPUT was checked above. Linux build directories are expected to be private
# to the caller, matching the existing macOS builder's no-replacement contract.
mv "$CANDIDATE" "$OUTPUT"
printf '%s\n' "$OUTPUT"
