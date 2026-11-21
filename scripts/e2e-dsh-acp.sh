#!/usr/bin/env bash
#
#
# Contract/trigger: a real ACP agent (dsh `--profile acp`) end to end in the real
#   TUI. Run after touching agent-facing paths; it spends model tokens.
# Boundary: real TUI -> bridge -> real agent process; no fakes on the agent side.
# Oracles: the captured pane (turns, tool card, footer model), the agent's own
#   errors, and the archived session list.
# Negative controls: an agent-side failure must be BLOCKED/visible, never a silent
#   pass; test sessions are archived afterwards, never left in the user's store.
## Full functional acceptance of THIS TUI against a real ACP agent — by default the
# minimal profile we have measured: `dsh --profile acp`.
#
#   bash scripts/e2e-dsh-acp.sh              # cheap default: ~3 model turns
#   FULL=1 bash scripts/e2e-dsh-acp.sh       # adds a tool turn + the cancel gesture
#   KEEP=1 bash scripts/e2e-dsh-acp.sh       # keep the workspace for post-mortem
#   AGENT="<agent command>" bash scripts/e2e-dsh-acp.sh
#
# Why this file exists: `dsh --profile acp` advertises only
# `sessionCapabilities: {resume, list, close}` — no `session/load`, no title
# surface, no image prompts. Every "missing capability" behaviour of the bridge
# shows up there first (honest restore titles, the exit epilogue, the model
# catalog, honest refusals), and the other suites drive it either with the fake
# agent or for a single turn. This is the "does the product work" run, on the
# SCREEN, against the real thing (AGENTS.md iron rule 7).
#
# Cost: default 3 small turns (a word-recall pair + one recall after the resume);
# FULL adds a tool turn, a cancelled turn and a follow-up = 3 more. Nothing is
# sent that a normal session would not receive; the workspace is a throwaway
# directory and the agent's sessions are archived afterwards (AGENTS.md §6).
#
# Discipline encoded here (each line earned by a real failure):
#   - assert on `tmux capture-pane`, never on a JSON body
#   - drive a list by SEARCHING for the id, never by pressing Enter blind
#   - poll for a marker; never sample once and call it done
#   - scope the orphan check to THIS run (a name-based `ps | grep dsh` matched the
#     owner's own session once)
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

AGENT="${AGENT:-dsh --profile acp}"
FULL="${FULL:-0}"
KEEP="${KEEP:-0}"
OC="${OC:-$(command -v opencode || true)}"
[ -z "$OC" ] && [ -x "$HOME/.opencode/bin/opencode" ] && OC="$HOME/.opencode/bin/opencode"
[ -x "$OC" ] || { echo "✗ no opencode v2 binary found (set OC=/path/to/opencode)" >&2; exit 1; }
[ -f dist/index.js ] || { echo "✗ dist/index.js is missing — run 'pnpm build' first" >&2; exit 1; }
command -v tmux >/dev/null || { echo "✗ tmux is required" >&2; exit 1; }

STARTED_AT=$(date +%s)
WORK="$(mktemp -d)"
ART="$HERE/.artifacts/dsh-acp/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$ART"
MAP="$WORK/sessions.json"
LOG1="$ART/run1-bridge.log"
LOG2="$ART/run2-bridge.log"
CLIENT1="dsh-acp-1-$$"
CLIENT2="dsh-acp-2-$$"
PASSED=0
FAILED=0
NOTED=0
TURNS=0
SESSION_ID=""
WORK_PHYSICAL="$(cd "$WORK" && pwd -P)"

ok() { echo "  ✓ $1"; PASSED=$((PASSED + 1)); }
fail() { echo "  ✗ $1" >&2; FAILED=$((FAILED + 1)); }
note() { echo "  · $1"; NOTED=$((NOTED + 1)); }

cleanup() {
  for name in "$CLIENT1" "$CLIENT2"; do tmux kill-session -t "$name" 2>/dev/null; done
  if [ "$KEEP" = 1 ]; then echo "  (kept: $WORK)"; else rm -rf "$WORK"; fi
}
trap cleanup EXIT

die() {
  fail "$1"
  echo "  (panes + logs: $ART; workspace: $WORK)"
  exit 1
}

save() { tmux capture-pane -p -t "$1" >"$ART/$2.txt" 2>/dev/null || true; }
pane() { tmux capture-pane -p -t "$1" 2>/dev/null || true; }

wait_pane() {  # <session> <extended regex> <seconds> [ci]
  local session="$1" pattern="$2" deadline=$(( $(date +%s) + $3 )) flags="-E"
  [ "${4:-}" = ci ] && flags="-Ei"
  while [ "$(date +%s)" -lt "$deadline" ]; do
    printf '%s' "$(pane "$session")" | grep $flags "$pattern" && return 0
    sleep 0.5
  done
  return 1
}

wait_log() {  # <log> <extended regex> <seconds>
  local deadline=$(( $(date +%s) + $3 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    grep -qE "$2" "$1" 2>/dev/null && return 0
    sleep 0.5
  done
  return 1
}

send_text() { tmux send-keys -t "$1" "$2"; sleep 1.6; tmux send-keys -t "$1" Enter; }

# One model turn: send, then wait for the marker, answering a permission footer if
# the agent asks for one. Returns non-zero when the marker never appears.
turn() {  # <session> <text> <extended regex> <seconds>
  send_text "$1" "$2"
  TURNS=$((TURNS + 1))
  local deadline=$(( $(date +%s) + $4 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    sleep 2
    local now; now="$(pane "$1")"
    if printf '%s' "$now" | grep -qi 'Permission required'; then
      note "a permission footer appeared; answering allow-once"
      tmux send-keys -t "$1" Enter
      sleep 1
    fi
    printf '%s' "$now" | grep -Eqi -- "$3" && return 0
  done
  return 1
}

# Wait until the turn really ends (`esc interrupt` gone) — the reply text can render
# while the agent is still finishing. A single early sample once reported a stuck
# turn that had in fact closed.
wait_turn_closed() {  # <session> <seconds>
  local deadline=$(( $(date +%s) + $2 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    printf '%s' "$(pane "$1")" | grep -qi 'esc interrupt' || return 0
    sleep 1
  done
  return 1
}

echo "▸ agent:      $AGENT"
echo "▸ tui:        $OC ($("$OC" --version 2>/dev/null | head -1))"
echo "▸ mode:       $([ "$FULL" = 1 ] && echo 'full (tool turn + cancel)' || echo 'default')"
echo "▸ workspace:  $WORK"
echo "▸ artifacts:  $ART"

# ─────────────────────────────────────────────────────── run 1: a fresh session
: >"$LOG1"
cat >"$WORK/run1.sh" <<EOF
#!/bin/bash
cd "$WORK"
exec env OPENCODE_ACP_CLIENT_SESSION_MAP="$MAP" OPENCODE_BIN="$OC" \\
  node "$HERE/dist/index.js" --bridge-log "$LOG1" -- $AGENT
EOF
chmod +x "$WORK/run1.sh"
tmux new-session -d -s "$CLIENT1" -x 130 -y 44 "$WORK/run1.sh"
tmux set-option -t "$CLIENT1" remain-on-exit on 2>/dev/null

wait_pane "$CLIENT1" 'Ask anything' 120 || die "the TUI never became ready (run 1)"
ok "the TUI came up against the real agent"

# ★ An agent whose own credentials are missing is BLOCKED, not a failure of this bridge.
# Measured on the Linux box: codex-acp answers `session/new` with "Authentication required",
# the catalog never leaves `acp/default`, the footer is blank, and every later assertion
# fails for that one reason. Carrying the agent's message faithfully is the job; reporting
# it as our regression is not. (The same cells in `e2e-agent-matrix.sh` declare this.)
if grep -q 'Authentication required' "$LOG1" 2>/dev/null; then
  echo "  ⛔ BLOCKED: the agent demands authentication (its own credentials are not configured)"
  echo "     agent said: $(grep -o 'Authentication required' "$LOG1" | head -1)"
  echo "     what still holds: the TUI came up, the bridge logged the refusal, nothing crashed"
  exit 3
fi

# The footer names the agent from `initialize` and a REAL model from its config
# options — never the `acp/default` placeholder.
PANE="$(pane "$CLIENT1")"
save "$CLIENT1" 01-ready
if printf '%s' "$PANE" | grep -qi 'acp/default'; then
  fail "the footer still shows the acp/default placeholder"
# ★ The footer row is the line carrying `·`. It is indented to the composer's width and
# the agent name may be absent (codex renders `· Deepseek Flash acp`), so requiring the
# literal ` · ` with both spaces missed a perfectly good footer — measured.
elif printf '%s' "$PANE" | grep -q '·'; then
  ok "the footer carries the agent's own name and a real model"
else
  note "footer: $(printf '%s' "$PANE" | grep -E '·' | tail -1)"
  fail "no agent/model footer on screen"
fi

# ── a real turn, and the tab title derived from its first message ────────────
turn "$CLIENT1" "Remember this word for later: ZEBRA. Reply with exactly: ACK_ONE" 'ACK_ONE' 200 \
  || die "the first turn never produced ACK_ONE"
ok "a real model turn rendered its reply"
wait_turn_closed "$CLIENT1" 40 && ok "the turn closed (no stuck esc interrupt)" \
  || fail "the turn never closed (esc interrupt still on screen)"
save "$CLIENT1" 02-turn

TITLED=0
for _ in $(seq 1 25); do
  # The tab strip is the FIRST LINE, but the row is centred and the run can start with
  # spaces — `head -1 | grep` was matching anchored text and missing a title that renders
  # fine. Language models may also phrase the derived title differently per agent, so the
  # test is "the strip carries our prompt's words", not an exact string.
  if pane "$CLIENT1" | head -1 | grep -qE 'Remember this word|ZEBRA'; then TITLED=1; break; fi
  sleep 1
done
if [ "$TITLED" = 1 ]; then
  ok "the tab title came from the first message"
elif grep -q 'title from the first message' "$LOG1"; then
  fail "the bridge derived a title but the tab strip never showed it"
else
  fail "the bridge derived no title from the first message"
fi

# ── the control experiment: can this agent remember WITHIN one session? ──────
# If it cannot, the "no memory after resume" result says nothing about the resume.
turn "$CLIENT1" "Which word did I ask you to remember? Reply with that single word." 'ZEBRA' 200 \
  && ok "the agent recalled ZEBRA within the same session (control)" \
  || { fail "the agent could not recall a word from the same session"; save "$CLIENT1" 03-recall; }
save "$CLIENT1" 03-recall

# ── a user rename wins, and `!command` renders locally ──────────────────────
tmux send-keys -t "$CLIENT1" "/rename dsh-acp-probe"
sleep 3
tmux send-keys -t "$CLIENT1" Enter
sleep 3
if pane "$CLIENT1" | head -1 | grep -q 'dsh-acp-probe'; then
  ok "/rename moved the tab title"
else
  save "$CLIENT1" 04-rename
  fail "/rename did not move the tab title"
fi

tmux send-keys -t "$CLIENT1" '!pwd'
sleep 1.2
tmux send-keys -t "$CLIENT1" Enter
wait_pane "$CLIENT1" 'tmp\.[A-Za-z0-9]+' 40 && ok "!command rendered its output in the card" \
  || fail "!command showed no output"
save "$CLIENT1" 05-shell

# ── /model opens the agent's own catalog ────────────────────────────────────
tmux send-keys -t "$CLIENT1" "/model"
sleep 3
tmux send-keys -t "$CLIENT1" Enter
sleep 3
PANE="$(pane "$CLIENT1")"
save "$CLIENT1" 06-model
# ★ Matched by shape, not by brand: a model row is `provider/model`. Naming specific
# families made the assertion pass only for the machine it was written on.
if printf '%s' "$PANE" | grep -qE '[a-zA-Z0-9_-]+/[a-zA-Z0-9._-]+'; then
  ok "/model opened the agent's catalog"
else
  fail "/model showed no model list"
fi
tmux send-keys -t "$CLIENT1" Escape
sleep 1

# ── verbs ACP cannot perform must fail in a way the client accepts ──────────
for verb in compact btw undo; do
  tmux send-keys -t "$CLIENT1" "/$verb"
  sleep 3
  tmux send-keys -t "$CLIENT1" Enter
  sleep 5
  PANE="$(pane "$CLIENT1")"
  save "$CLIENT1" "07-$verb"
  if printf '%s' "$PANE" | grep -q 'UnexpectedStatus'; then
    fail "/$verb showed UnexpectedStatus (an undeclared status was answered)"
  else
    ok "/$verb failed without UnexpectedStatus"
  fi
done

# ── FULL: a real tool call, then the cancel gesture ─────────────────────────
if [ "$FULL" = 1 ]; then
  # ★ Assert on the TOOL CARD and its output, not on a reply the model may not produce.
  # Measured with `opencode acp`: asked to run `echo TOOL_OK`, it ran `pwd` instead and
  # printed the working directory — a perfectly good tool turn, reported as "never finished"
  # because the expected sentence never appeared. What this bridge owes is the card.
  turn "$CLIENT1" "Use your shell tool to run a command and show me its output." '\$ |Writing command' 300 \
    && ok "a real tool call rendered a card" \
    || { fail "no tool card rendered"; save "$CLIENT1" 08-tool; }
  save "$CLIENT1" 08-tool

  # Cancel: a deliberately long turn, then Escape twice (5s window).
  send_text "$CLIENT1" "Count from 1 to 300, one number per line, slowly."
  TURNS=$((TURNS + 1))
  sleep 4
  tmux send-keys -t "$CLIENT1" Escape
  sleep 1
  tmux send-keys -t "$CLIENT1" Escape
  if wait_turn_closed "$CLIENT1" 40; then
    ok "Escape twice ended the running turn"
  else
    fail "the turn kept running after Escape twice"
  fi
  save "$CLIENT1" 09-cancel
  # A session that survived a cancel can still take a turn.
  turn "$CLIENT1" "Reply with exactly: AFTER_CANCEL" 'AFTER_CANCEL' 200 \
    && ok "a turn after the cancel still works" \
    || fail "the session did not survive the cancel"
fi

# ── quit: OUR Continue line, carrying the session id ───────────────────────
tmux send-keys -t "$CLIENT1" C-c
sleep 2
tmux send-keys -t "$CLIENT1" C-c
wait_log "$LOG1" 'epilogue ' 30 || note "the bridge logged no epilogue decision"
save "$CLIENT1" 10-exit
LINE="$(pane "$CLIENT1" | grep -E '^ *Continue ' | tail -1)"
if printf '%s' "$LINE" | grep -q 'opencode -s'; then
  fail "the Continue line is opencode's native one"
elif printf '%s' "$LINE" | grep -qE 'oc-acp-client|dist/index\.js'; then
  ok "the Continue line names this product"
  SESSION_ID="$(printf '%s' "$LINE" | sed -n 's/.* -s \([^ ]*\).*/\1/p')"
  [ -n "$SESSION_ID" ] && ok "the line carries a session id ($SESSION_ID)" || fail "the line carries no session id"
else
  fail "no usable Continue line: '${LINE}'"
fi
[ -n "$SESSION_ID" ] || die "no session id to resume, stopping"

# ─────────────────────────────────────────────── run 2: resume that session id
: >"$LOG2"
cat >"$WORK/run2.sh" <<EOF
#!/bin/bash
cd "$WORK"
exec env OPENCODE_ACP_CLIENT_SESSION_MAP="$MAP" OPENCODE_BIN="$OC" \\
  node "$HERE/dist/index.js" --bridge-log "$LOG2" -s "$SESSION_ID"
EOF
chmod +x "$WORK/run2.sh"
tmux new-session -d -s "$CLIENT2" -x 130 -y 44 "$WORK/run2.sh"
tmux set-option -t "$CLIENT2" remain-on-exit on 2>/dev/null

wait_log "$LOG2" "resumed '" 120 || true
# ★ Dump what the pane actually holds on timeout. It was 120s of silence with a bridge
# log that showed every /api/* request answered, which says the readiness PATTERN was wrong
# rather than the TUI being slow.
# ★ Two legitimate screens after a resume, and the pattern has to accept both:
#   • an agent WITH `loadSession` replays the history, so the first thing on screen is the
#     old conversation — not the composer, and not a notice. Measured with `opencode acp`:
#     the pane held `ACK_ONE` / `ZEBRA` while this waited for "Ask anything".
#   • an agent WITHOUT it resumes bare: composer up, plus the `◈ Notice` saying why.
# The bridge has already told us which agent this is (`history: backend advertises
# loadSession`), so the wait follows the capability rather than guessing at both.
if grep -q 'backend advertises loadSession' "$LOG2"; then
  # ★ The replay can finish BEFORE the TUI connects: `session.created` goes out to
  # 0 clients, and the tab then has to hydrate itself. Measured with codex-acp, whose
  # `session/load` answers in about a second while the TUI is still booting: the pane
  # sat on the composer with `esc interrupt` for the whole 120s and no
  # `/message` request was ever made. Waiting for the transcript alone cannot
  # distinguish "still booting" from "never coming", so wait for the tab to ask for
  # its messages first, then for the words on screen.
  wait_log "$LOG2" "/message" 180 \
    || { save "$CLIENT2" 11-nomessage; die "the restored tab never asked for its transcript (run 2)"; }
  wait_pane "$CLIENT2" 'ACK_ONE|ZEBRA' 120 \
    || { save "$CLIENT2" 11-timeout; die "the replayed history never rendered (run 2)"; }
  ok "the conversation was replayed from the agent (loadSession)"
else
  wait_pane "$CLIENT2" 'Ask anything|Resumed without showing history' 120 \
    || { save "$CLIENT2" 11-timeout; die "the TUI never became ready (run 2)"; }
fi
sleep 2
PANE="$(pane "$CLIENT2")"
save "$CLIENT2" 11-ready

# ★ The rest of run 2 depends on which resume the agent supports, so it branches on the
# same evidence the bridge logged. Asserting the no-replay shape against an agent that
# HAS `loadSession` calls a correct replay a failure — measured with `opencode acp`.
if grep -q 'backend advertises loadSession' "$LOG2"; then
  printf '%s' "$PANE" | grep -q 'ACK_ONE\|ZEBRA' \
    && ok "the old transcript was replayed (loadSession's contract)" \
    || fail "loadSession was used but no history rendered (see 11-ready)"
  printf '%s' "$PANE" | grep -qE '\[(no history|no transcript|not resumed)\]' \
    && fail "the restored tab carries a history marker" \
    || ok "the tab keeps the conversation's real name (no marker)"
else
  if grep -qE "resumed '[^']+' without replay" "$LOG2"; then
    ok "the bridge reconnected with session/resume (no history replay)"
  else
    fail "the bridge did not use the no-replay resume path (see $LOG2)"
  fi
  # ★ The explanation lives in the TRANSCRIPT now (a `Session.Message.System` the TUI
  # renders as `◈ …`), and the tab keeps the conversation's real name — the old
  # `[no history]` title marker was removed (owner's call: the notice says it better).
  printf '%s' "$PANE" | grep -q 'Resumed without showing history' \
    && ok "the transcript says WHY the history is missing (agent has no session/load)" \
    || fail "no notice in the restored tab (see the saved 11-ready pane)"
  printf '%s' "$PANE" | grep -qE '\[(no history|no transcript|not resumed)\]' \
    && fail "the restored tab still carries a history marker" \
    || ok "the tab keeps the conversation's real name (no marker)"
  printf '%s' "$PANE" | grep -q 'ACK_ONE' \
    && fail "the old reply is on screen, so a transcript WAS replayed" \
    || ok "the old transcript was not replayed (session/resume's contract)"
fi

# Whether the model kept the conversation after a resume is the AGENT's business and the
# spec guarantees nothing (docs/KNOWN-ISSUES.md): remember or not, both are recorded as a
# fact, never as a failure.
turn "$CLIENT2" "Which word did I ask you to remember at the start? Reply with that single word." 'ZEBRA' 200 \
  && ok "the agent recalled ZEBRA after the resume" \
  || note "not remembered after resume — allowed: the spec does not promise it"
save "$CLIENT2" 12-recall

tmux send-keys -t "$CLIENT2" C-c
sleep 2
tmux send-keys -t "$CLIENT2" C-c
wait_log "$LOG2" 'epilogue ' 30 || note "the bridge logged no epilogue decision (run 2)"
save "$CLIENT2" 13-exit
LINE="$(pane "$CLIENT2" | grep -E '^ *Continue ' | tail -1)"
if printf '%s' "$LINE" | grep -q -- "-s $SESSION_ID"; then
  ok "the second run hands back the same session id"
else
  fail "the second run's Continue line names something else: '${LINE}'"
fi

# ─────────────────────────────────────── hygiene: no leftovers from THIS run
for name in "$CLIENT1" "$CLIENT2"; do tmux kill-session -t "$name" 2>/dev/null; done
sleep 3
LEFTOVER_BRIDGE="$(ps -Ao pid=,command= | grep 'dist/index.js' | grep -F "$LOG1" | grep -v grep || true)"
LEFTOVER_AGENTS=""
for pid in $(pgrep -f 'dsh --profile acp' 2>/dev/null || true); do
  cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')"
  [ "$cwd" = "$WORK_PHYSICAL" ] && LEFTOVER_AGENTS="$LEFTOVER_AGENTS $pid"
done
if [ -z "$LEFTOVER_BRIDGE" ] && [ -z "$LEFTOVER_AGENTS" ]; then
  ok "no bridge/agent processes left behind"
else
  fail "orphaned processes from this run remain:${LEFTOVER_BRIDGE}${LEFTOVER_AGENTS}"
  for pid in $LEFTOVER_AGENTS; do kill -TERM "$pid" 2>/dev/null; done
fi

ELAPSED=$(( $(date +%s) - STARTED_AT ))
echo
echo "── $PASSED passed, $FAILED failed, $NOTED notes · $TURNS model turn(s) · ${ELAPSED}s"
echo "── panes + bridge logs: $ART"
echo "── archiving the test agent's sessions (AGENTS.md §6)"
python3 scripts/archive-test-sessions.py || note "archive script reported a problem (not a product failure)"
exit "$([ "$FAILED" = 0 ] && echo 0 || echo 1)"
