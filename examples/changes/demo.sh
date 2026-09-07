#!/usr/bin/env bash
# Only the fresh fixture created here is ever targeted; no target arguments.
set -euo pipefail
if [ "$#" -ne 0 ]; then
  printf 'This demo accepts no arguments or external targets.\n' >&2
  exit 64
fi
script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
demo="$(bash "$script_dir/prepare.sh")"
export AIRLOCK_HOME="$demo/airlock-home"
printf 'Scratch fixture and retained recovery state: %s\n' "$demo"

airlock-agent change stage --source "$demo/candidate" --target "$demo/live" > "$demo/stage.json"
cat "$demo/stage.json"
id="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])' < "$demo/stage.json")"
digest="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["proposalDigest"])' < "$demo/stage.json")"
if [[ ! "$digest" =~ ^sha256:[[:xdigit:]]{64}$ ]]; then
  printf 'Stage did not return a full proposal digest; refusing.\n' >&2
  exit 1
fi
airlock-agent change review "$id"
airlock-agent change review "$id" --diff
printf '\nReview the proposal above. Type APPLY to install %s into scratch target %s/live: ' "$digest" "$demo"
IFS= read -r approval
if [ "$approval" != APPLY ]; then
  airlock change cancel "$id"
  printf 'Cancelled; scratch evidence remains at %s\n' "$demo"
  exit 0
fi

airlock change apply "$id" --expect-digest "$digest" > "$demo/apply.json"
cat "$demo/apply.json"
receipt_id="$(python3 -c 'import json,sys; r=json.load(sys.stdin); assert r["state"] == "installed", r; print(r["receiptId"])' < "$demo/apply.json")"
airlock change status "$id"
cmp "$demo/candidate/config.json" "$demo/live/config.json"
cmp "$demo/candidate/README.txt" "$demo/live/README.txt"
test ! -e "$demo/live/obsolete.txt"

airlock change undo "$receipt_id" > "$demo/undo.json"
cat "$demo/undo.json"
python3 -c 'import json,sys; r=json.load(sys.stdin); assert r["state"] == "undone", r' < "$demo/undo.json"
test "$(cat "$demo/live/config.json")" = '{"message":"before","workers":1}'
test -f "$demo/live/obsolete.txt"
test ! -e "$demo/live/README.txt"
airlock change status "$id"
printf 'PASS: scratch replacement and checked undo. Retained evidence: %s\n' "$demo"
