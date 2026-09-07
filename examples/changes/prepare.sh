#!/usr/bin/env bash
# Fresh scratch only; stdout is the fixture path for DEMO="$(bash .../prepare.sh)".
set -euo pipefail
umask 077
script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
demo="$(mktemp -d "${TMPDIR:-/tmp}/airlock-changes.XXXXXXXX")"
mkdir "$demo/live" "$demo/candidate" "$demo/airlock-home"
printf '{"message":"before","workers":1}\n' > "$demo/live/config.json"
printf 'Retained through Hold when absent from the candidate.\n' > "$demo/live/obsolete.txt"
python3 "$script_dir/generate.py" "$demo/candidate"
printf '%s\n' "$demo"
