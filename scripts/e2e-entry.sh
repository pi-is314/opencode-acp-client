#!/usr/bin/env bash
#
#
# Contract/trigger: `oc-acp-client -- <agent>` starts the TUI and the agent, and
#   one exit tears both down. Run for CLI parsing, lifecycle or spawn changes.
# Boundary: the real entry point with a stand-in TUI (`tests/fake-opencode-tui.mjs`)
#   that answers `--version` like the real binary.
# Oracles: exit codes, the ready line, and the absence of surviving processes —
#   asserted after the process exited, never during.
# Negative controls: nothing may be left behind (tmux, bridge, agent, temp dirs);
#   a non-zero TUI exit must not be reported as success.
## The single entry point, end to end: one command starts the TUI and the agent.
#
# One command starts the opencode TUI against a private ACP server, and nothing
# is left behind when either side exits. The TUI is stood in for by
# `tests/fake-opencode-tui.mjs` — it answers `--version` the way the real binary
# does, which is all the version gate needs — so this runs without a real
# opencode install and without a model.
#
# Usage:
#   bash scripts/e2e-entry.sh                      # fake agent (no model)
#   AGENT="<agent command>" bash scripts/e2e-entry.sh
#
# `AGENT` is a command line, split on spaces; it must be runnable from
# `--directory`, which is what the bridge spawns it in.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

TUI="$HERE/tests/fake-opencode-tui.mjs"
AGENT="${AGENT:-node $HERE/tests/fake-acp-agent.mjs}"
# Only the fake agent has a name we can safely look for in the process table;
# for a real one the operator knows what they passed.
AGENT_PROBE=""
case "$AGENT" in
  *fake-acp-agent.mjs*) AGENT_PROBE='fake-acp-agent\.mjs' ;;
esac
BRIDGE_PID=""
MAP_DIR="$(mktemp -d)"
export OPENCODE_ACP_CLIENT_SESSION_MAP="$MAP_DIR/sessions.json"

# A leftover check may only see *this* run's processes. Anything already matching
# the probe pattern belongs to someone else — an earlier run, another window, a
# manual experiment — and must not turn this suite red: a gate that fails for
# reasons outside the run under test is worse than no gate at all.
# `|| true` inside the substitution matters: with `set -e` a `pgrep` that matches
# nothing would fail the assignment and silently kill the whole script.
matching_pids() { { pgrep -f "$1" 2>/dev/null || true; } | sort | tr '\n' ' '; }
snapshot_matching() { matching_pids "$1"; }
no_leftovers() {  # $1 = pattern, $2 = pids that belonged to this run, $3 = label, $4 = seconds
  # Waiting *before* the assertion is not enough — that version could see nothing
  # and have the very next check see something, which is how this failed one run in
  # eight while its own timeout diagnostic never fired (the check never timed out).
  # A process that appears transiently while the bridge is still tearing down is not
  # a leak, so retry the assertion itself and only fail if it *stays*.
  local deadline=$(( $(date +%s) + ${4:-20} ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if [ -z "$(new_since "$1" "$2")" ]; then
      ok "no leftover $3"
      return 0
    fi
    sleep 0.5
  done
  local left
  left="$(new_since "$1" "$2")"
  fail "the $3 outlived the run: $left"
  for pid in $left; do
    echo "  · still alive after ${4:-20}s:" >&2
    ps -o pid=,ppid=,etime=,command= -p "$pid" 2>/dev/null | cut -c1-140 >&2
  done
  return 1
}

new_since() {
  local now out=""
  now="$(matching_pids "$1")"
  for pid in $now; do
    case " $2 " in *" $pid "*) ;; *) out="$out $pid" ;; esac
  done
  printf '%s' "$out"
}
TUI_BEFORE="$(snapshot_matching 'fake-opencode-tui\.mjs')"

# Wait for this run's processes to disappear instead of sampling once: shutdown
# latency is not zero, and "still there after 0.5s" is not the same as "leaked".
AGENT_BEFORE=""
[ -n "$AGENT_PROBE" ] && AGENT_BEFORE="$(snapshot_matching "$AGENT_PROBE")"
FAILED=0

fail() { echo "  ✗ $1" >&2; FAILED=1; }
ok() { echo "  ✓ $1"; }

cleanup() {
  # Explicit PIDs only: never a name-based kill.
  [ -n "$BRIDGE_PID" ] && kill -TERM "$BRIDGE_PID" 2>/dev/null || true
  [ -n "$BRIDGE_PID" ] && wait "$BRIDGE_PID" 2>/dev/null || true
  rm -rf "$MAP_DIR"
}
trap cleanup EXIT

echo "▸ building"
pnpm build >/dev/null

echo "▸ agent: $AGENT"
echo "▸ tui:   $TUI"

# ---------------------------------------------------------------------------
echo
echo "▸ the TUI's exit code becomes ours, and nothing is left running"
ARGS_FILE="$(mktemp)"
OUT="$(mktemp)"
(
  cd "$HERE"
  FAKE_TUI_EXIT=7 FAKE_TUI_ARGS="$ARGS_FILE" OPENCODE_BIN="$TUI" exec node dist/index.js "$HERE" -- $AGENT
) >"$OUT" 2>&1 &
BRIDGE_PID=$!
CODE=0
wait "$BRIDGE_PID" || CODE=$?
BRIDGE_PID=""
[ "$CODE" = "7" ] && ok "exit code propagated (7)" || fail "expected exit 7 from the TUI, got $CODE"
ARGS="$(tr -d '\n' <"$ARGS_FILE")"
case "$ARGS" in
  *'"--server"'*) ok "the TUI was pointed at our server: $ARGS" ;;
  *) fail "the TUI was not given --server: $ARGS" ;;
esac
case "$(head -1 "$OUT")" in
  '[bridge] logs:'*) ok "logs went to a file, not the TUI's terminal" ;;
  *) fail "expected the log path on stderr, got: $(head -1 "$OUT")" ;;
esac
no_leftovers 'fake-opencode-tui\.mjs' "$TUI_BEFORE" TUI || true
if [ -n "$AGENT_PROBE" ]; then
  no_leftovers "$AGENT_PROBE" "$AGENT_BEFORE" agent || true
fi
rm -f "$ARGS_FILE" "$OUT"

# ---------------------------------------------------------------------------
echo
echo "▸ SIGTERM stops both the TUI and the agent"
FAKE_TUI_SLEEP_MS=60000 OPENCODE_BIN="$TUI" node dist/index.js "$HERE" -- $AGENT \
  >/tmp/e2e-entry-sigterm.log 2>&1 &
BRIDGE_PID=$!
for _ in $(seq 1 80); do
  grep -q '"type":"ready"' /tmp/e2e-entry-sigterm.log 2>/dev/null && break
  sleep 0.25
done
sleep 1
kill -TERM "$BRIDGE_PID"
EXIT_CODE=0
wait "$BRIDGE_PID" || EXIT_CODE=$?
BRIDGE_PID=""
[ "$EXIT_CODE" = "0" ] && ok "bridge exited 0 on SIGTERM" || fail "bridge exited $EXIT_CODE on SIGTERM"
no_leftovers 'fake-opencode-tui\.mjs' "$TUI_BEFORE" leftovers || true

# ---------------------------------------------------------------------------
echo
echo "▸ an agent command that cannot run fails fast, with a reason"
ERR="$(mktemp)"
CODE=0
node dist/index.js "$HERE" -- /nonexistent-agent-xyz >"$ERR" 2>&1 || CODE=$?
[ "$CODE" != "0" ] && ok "non-zero exit ($CODE)" || fail "a missing agent command exited 0"
grep -q 'agent command not found' "$ERR" && ok "the reason is readable" || fail "no readable reason: $(cat "$ERR")"
rm -f "$ERR"

echo
if [ "$FAILED" = "0" ]; then
  echo "✓ single entry point holds"
else
  echo "✗ single entry point failed" >&2
  exit 1
fi
