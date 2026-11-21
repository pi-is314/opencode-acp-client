#!/usr/bin/env bash
# The hand-written test counts in the docs have trailed the suite six times now, and
# nothing ever failed. This makes the gate fail instead.
#
# It reads only the sentences that are *about the suite total* — not every number in the
# file. An earlier version grepped every "N passed" and flagged the OpenAPI probe
# baseline ("24 pass / 19 notes") and even vitest's own "Test Files 12 passed" line.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

# `Tests  157 passed (157)` — not the file count two lines above it.
#
# Keep the output. The first version discarded it, and when a gate run failed here (it was
# racing an edit of the test tree) the log carried only "could not read the suite total",
# with nothing to diagnose. The tail now goes to stderr on failure.
OUT="$(mktemp)"
trap 'rm -f "$OUT"' EXIT
pnpm test >"$OUT" 2>&1 || true
REPORT="$(grep -E '^[[:space:]]*Tests[[:space:]]+[0-9]+ passed' "$OUT" | grep -oE '[0-9]+' | head -1)"
if [ -z "$REPORT" ]; then
  echo "  ✗ could not read the suite total from pnpm test; last lines:" >&2
  tail -20 "$OUT" | sed 's/^/    /' >&2
  exit 1
fi

claims() { # file, regex (the number is group 1)
  [ -f "$1" ] || return 0
  grep -ohE "$2" "$1" 2>/dev/null | grep -oE '[0-9]+' | sort -u
}

status=0
check() { # file, regex, human name
  local file="$1" pattern="$2" label="$3"
  for claimed in $(claims "$file" "$pattern"); do
    if [ "$claimed" != "$REPORT" ]; then
      echo "  ✗ $file ($label) claims $claimed tests; the suite reports $REPORT" >&2
      status=1
    fi
  done
}

check AGENTS.md              '[0-9]+ passed'      'test state'
check AGENTS.zh.md           '[0-9]+ passed'      'test state'
check README.md              '[0-9]+ pass,'       'status table'
check README.zh.md           '[0-9]+ 通过'         'status table'
check docs/DEVELOPMENT.md    '[0-9]+ unit cases'  'testing section'
check docs/DEVELOPMENT.zh.md '[0-9]+ 个单测'       'testing section'

[ "$status" = 0 ] && echo "  ✓ every documented test count matches the suite ($REPORT)"
exit "$status"
