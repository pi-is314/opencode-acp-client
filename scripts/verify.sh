#!/usr/bin/env bash
#
# Everything this repository can prove about itself, in one command.
#
#   pnpm verify
#
# What it runs: typecheck, the unit suite, the published-spec conformance check,
# and the e2e suites that need only node + tmux + an opencode v2 binary
# (smoke, entry, real TUI, and the exit epilogue). `scripts/e2e-real-agent.sh` is deliberately **not**
# here: it needs a real ACP agent installed, so it is a separate,
# occasional check rather than a gate.
#
# What it does NOT prove, however green it is: that a real *agent's* answers are
# sensible, that the TUI looks right on your terminal, or that any opencode
# version other than the one under test works. Those are the jobs of
# `scripts/check-opencode-version.sh` (many versions) and your own eyes.
#
# Environment:
#   OC=<path>              opencode binary for the real-TUI step
#   OPENCODE_SPEC=<path>   use this spec file instead of .cache/openapi.json
#   OPENCODE_SPEC_MAX_AGE=<s>
#                          how old the cached spec may be before it is re-fetched
#                          (default 86400; 0 always fetches, a large value pins it)
#   PYTHON=<cmd>           python3 by default (the spec check needs jsonschema)
#   VERIFY_SKIP_TUI=1      skip the real-TUI step (prints a loud warning)
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"
SPEC="${OPENCODE_SPEC:-$REPO/.cache/openapi.json}"
PY="${PYTHON:-python3}"
SPEC_URL="https://opencode.ai/v2/openapi.json"

step() { printf '\n▸ %s\n' "$1"; }
fail() { printf '\n✗ %s\n' "$1" >&2; exit 1; }

step "typecheck"
pnpm typecheck || fail "typecheck"

step "unit tests"
pnpm test || fail "unit tests"

step "build (the e2e scripts drive dist/)"
pnpm build || fail "build"

step "docs links (an unmirrored bilingual pair is a broken link)"
"$PY" scripts/check-links.py || fail "docs links"

step "published-spec conformance"
# Refresh a stale cache, do not just fill a missing one. The published spec is the
# contract this bridge is checked against, and opencode adds to it with every release:
# a cached copy from before `Model.Type` existed rejected the `type: chat` this bridge
# began sending in v2.2, so the gate failed on a field the live spec declares. A cache
# is a network saving, not a frozen contract — `OPENCODE_SPEC` (`OPENCODE_SPEC_MAX_AGE`
# overrides the window, 0 forces a fetch) is still the way to pin one deliberately.
fetched=0
if [ ! -f "$SPEC" ]; then
  mkdir -p "$(dirname "$SPEC")"
  echo "  fetching $SPEC_URL"
  curl -fsSL -o "$SPEC" "$SPEC_URL" || fail "cannot fetch the spec (set OPENCODE_SPEC to a local copy)"
  fetched=1
elif [ "${OPENCODE_SPEC_MAX_AGE:-86400}" = "0" ] \
  || [ -n "$(find "$SPEC" -mtime +0 2>/dev/null)" ]; then
  echo "  refreshing $SPEC (older than ${OPENCODE_SPEC_MAX_AGE:-86400}s)"
  mkdir -p "$(dirname "$SPEC")"
  # ★ A 200 with an empty body happens (measured twice: a flaky edge returned nothing
  # and the check then died on `JSONDecodeError: char 0`, wasting a whole 15-minute gate).
  # `curl -f` only guards the HTTP status, so the body is checked before it replaces a
  # working cache: a stale contract beats an empty one.
  if curl -fsS -o "$SPEC.tmp" "$SPEC_URL" \
    && python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$SPEC.tmp" 2>/dev/null; then
    mv "$SPEC.tmp" "$SPEC"
    fetched=1
  else
    rm -f "$SPEC.tmp"
    # Offline: a stale contract beats no contract, and saying so keeps it honest.
    echo "  ! could not refresh the spec (offline or an empty body); using the cached copy — it may predate this release"
  fi
fi
"$PY" -c 'import jsonschema' 2>/dev/null \
  || fail "the spec check needs python3 + jsonschema (pip install jsonschema), or set PYTHON"
"$PY" scripts/check-openapi.py --spec "$SPEC" || fail "spec conformance"

step "e2e: smoke (20 scenarios, fake agent, real HTTP)"
bash scripts/e2e-smoke.sh || fail "e2e-smoke"

step "e2e: entry (single command, exit code, no strays)"
bash scripts/e2e-entry.sh || fail "e2e-entry"

if [ "${VERIFY_SKIP_TUI:-0}" = "1" ]; then
  printf '\n! e2e: real TUI SKIPPED (VERIFY_SKIP_TUI=1)\n'
  printf '! that is the only step that renders the real client — this run proves less\n'
else
  step "docs: the test counts the entry document prints"
  bash scripts/check-test-counts.sh || fail "check-test-counts: a documented count disagrees with the suite"

  step "e2e: real TUI, rendering (tmux; one assertion per layer, plus history)"
  command -v tmux >/dev/null || fail "tmux is required for the real-TUI step (or set VERIFY_SKIP_TUI=1 and accept the gap)"
  ARTIFACTS_DIR="${ARTIFACTS_DIR:-$REPO/.artifacts}" bash scripts/e2e-real-tui.sh \
    || fail "e2e-real-tui (rendering): the captured panes are in ${ARTIFACTS_DIR:-$REPO/.artifacts}"

  # The cancel gesture is a *client* interaction: a new opencode version can change
  # which verb it sends, or what it expects back, without breaking a single render.
  # The real TUI answered `UnexpectedStatus: 204` on every cancel once, and only this
  # mode would have caught it — so it belongs in the gate, not in an occasional run.
  # The permission dialog is its own interaction: the agent asks and waits, so the
  # turn can only finish if the keystrokes reached it. Same reasoning as cancel.
  step "e2e: real TUI, the permission dialog (asks, we answer, it closes)"
  ARTIFACTS_DIR="${ARTIFACTS_DIR:-$REPO/.artifacts}" MODE=permission \
    bash scripts/e2e-real-tui.sh \
    || fail "e2e-real-tui (permission): the captured panes are in ${ARTIFACTS_DIR:-$REPO/.artifacts}"

  step "e2e: real TUI, !command renders its output in the card"
  ARTIFACTS_DIR="${ARTIFACTS_DIR:-$REPO/.artifacts}" MODE=shell \
    bash scripts/e2e-real-tui.sh \
    || fail "e2e-real-tui (shell): a !command's card did not show its output"

  step "e2e: real TUI, a !command row survives reopening the session"
  ARTIFACTS_DIR="${ARTIFACTS_DIR:-$REPO/.artifacts}" MODE=shell-history \
    bash scripts/e2e-real-tui.sh \
    || fail "e2e-real-tui (shell-history): the reloaded transcript lost the !command row"

  step "e2e: real TUI, the full slash-command patrol"
  ARTIFACTS_DIR="${ARTIFACTS_DIR:-$REPO/.artifacts}" MODE=patrol \
    PROMPT_TEXT="patrol anchor line" REPLY_TEXT="PONG_FROM_AGENT" FAKE_ACP_REPLY="PONG_FROM_AGENT" \
    bash scripts/e2e-real-tui.sh \
    || fail "e2e-real-tui (patrol): a slash command crashed the TUI or answered an undeclared status"

  step "e2e: real TUI, the /cd working-directory switch"
  ARTIFACTS_DIR="${ARTIFACTS_DIR:-$REPO/.artifacts}" MODE=cd \
    bash scripts/e2e-real-tui.sh \
    || fail "e2e-real-tui (cd): the directory switch did not hold end to end"

  step "e2e: real TUI, a tool call on a session restored after a restart"
  ARTIFACTS_DIR="${ARTIFACTS_DIR:-$REPO/.artifacts}" MODE=restore-turn \
    bash scripts/e2e-real-tui.sh \
    || fail "e2e-real-tui (restore-turn): a restored session lost its next tool call"

  step "e2e: real TUI, reopening a session from the tab list after a restart"
  ARTIFACTS_DIR="${ARTIFACTS_DIR:-$REPO/.artifacts}" MODE=restore-tab \
    bash scripts/e2e-real-tui.sh \
    || fail "e2e-real-tui (restore-tab): the session list did not restore the transcript"

  step "e2e: real TUI, a stale active prompt is cancelled and retried"
  ARTIFACTS_DIR="${ARTIFACTS_DIR:-$REPO/.artifacts}" MODE=stale-prompt \
    bash scripts/e2e-real-tui.sh \
    || fail "e2e-real-tui (stale-prompt): the agent's stale-prompt error reached the screen"

  step "e2e: real TUI, a follow-up sent during a turn is queued"
  ARTIFACTS_DIR="${ARTIFACTS_DIR:-$REPO/.artifacts}" MODE=queue \
    bash scripts/e2e-real-tui.sh \
    || fail "e2e-real-tui (queue): a mid-turn follow-up was not queued"

  step "e2e: real TUI, a tool's command/query arrives after the pending frame"
  ARTIFACTS_DIR="${ARTIFACTS_DIR:-$REPO/.artifacts}" MODE=tool-stages \
    bash scripts/e2e-real-tui.sh \
    || fail "e2e-real-tui (tool-stages): a tool row stayed on the pending label"

  step "e2e: real TUI, v2.1's todo list is fed by a todowrite call"
  ARTIFACTS_DIR="${ARTIFACTS_DIR:-$REPO/.artifacts}" MODE=todo \
    bash scripts/e2e-real-tui.sh \
    || fail "e2e-real-tui (todo): the sidebar did not render the todowrite list"

  step "e2e: real TUI, /compact fails in a way the client accepts"
  ARTIFACTS_DIR="${ARTIFACTS_DIR:-$REPO/.artifacts}" MODE=unsupported-verb \
    bash scripts/e2e-real-tui.sh \
    || fail "e2e-real-tui (unsupported-verb): the TUI showed UnexpectedStatus"

  step "e2e: real TUI, single-entry !command renders its output"
  ARTIFACTS_DIR="${ARTIFACTS_DIR:-$REPO/.artifacts}" ENTRY=1 MODE=shell \
    bash scripts/e2e-real-tui.sh \
    || fail "e2e-real-tui (single-entry shell): a !command's card did not show its output"

  step "e2e: real TUI, the form dialog (asks a question, we answer, it closes)"
  ARTIFACTS_DIR="${ARTIFACTS_DIR:-$REPO/.artifacts}" MODE=form \
    bash scripts/e2e-real-tui.sh \
    || fail "e2e-real-tui (form): the captured panes are in ${ARTIFACTS_DIR:-$REPO/.artifacts}"

  step "e2e: real TUI, cancellation (Escape twice → session.interrupt)"
  ARTIFACTS_DIR="${ARTIFACTS_DIR:-$REPO/.artifacts}" MODE=cancel FAKE_ENV="FAKE_ACP_HANG=1 FAKE_ACP_HANG_TOOL=1 FAKE_ACP_MODELS=1" \
    bash scripts/e2e-real-tui.sh \
    || fail "e2e-real-tui (cancel): the captured panes are in ${ARTIFACTS_DIR:-$REPO/.artifacts}"

  # The exit epilogue is the only handoff from a finished conversation to the same
  # conversation again, and it is written by the client — so it is asserted on the
  # screen, with a real TUI, immediately after the run that proves the TUI renders.
  step "e2e: real TUI, the exit Continue line names this product and the right session"
  OC="${OC:-}" bash scripts/e2e-epilogue.sh \
    || fail "e2e-epilogue: the Continue line did not name this product / the right session (panes in .artifacts/epilogue)"
fi

printf '\n✓ verify passed\n'
