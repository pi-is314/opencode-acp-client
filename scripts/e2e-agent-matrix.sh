#!/usr/bin/env bash
#
# Eight real ACP agents, one after another, through the real TUI — the matrix the
# owner asked for ("the four most common agents: can our TUI talk to each?").
#
#   bash scripts/e2e-agent-matrix.sh
#   ONLY=claude,codex bash scripts/e2e-agent-matrix.sh   # a subset
#
# Each cell runs the same acceptance against a **real terminal** (tmux), one turn
# per agent, and asserts on the rendered screen — not on JSON (AGENTS.md iron rule
# 7). A cell that fails because of the agent's own credentials/config is reported
# as BLOCKED with the agent's own message, never as our regression: the bridge's
# job is to carry the turn faithfully, including errors.
#
# Outcomes per cell: PASS, BLOCKED (the agent's own credentials/config), and —
# since 2026-11-22 — `dead` as a FAIL: the agent PROCESS did not come up at all,
# so no turn was possible. `dead` exists because this harness once graded a dead
# agent as "the reply rendered": the old success test matched the broad `Error:`,
# and our own bridge row reads `Error: could not start the agent: agent exited:
# ACP connection closed`. Our errors are now excluded before the agent's are
# looked for, in both the `reply` and the `error` arms.
#
# Environment quirks handled here, each measured (2026-10-17):
#   - codex: the user's model list carries `"effort": "max"`, which the codex ACP
#     adapter rejects at startup ("unknown variant `max`"). The cell runs with a
#     temp HOME where that value is corrected — the user's file is never touched.
#   - opencode (`opencode acp`): the ACP subcommand has no provider credentials,
#     so its turn answers "Authentication required". That is the agent's limit,
#     reported as BLOCKED; the acceptance still proves connect + real model +
#     faithful error rendering.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"
# ★ The agents run inside tmux, and this harness's shell hands tmux a PATH that ends
# at /bin — no /usr/sbin. Measured 2026-11-22: `gemini --acp` calls
# `execFileSync('sysctl', ['-inq','sysctl.proc_translated'])` while starting, got
# ENOENT, and died of an uncaught exception BEFORE any session existed. That looked
# like a TUI/agent defect for an hour; it was a missing directory in PATH. The system
# sbin directories are part of a normal macOS PATH, so the harness supplies them
# rather than making every agent fight the environment it is launched in.
case ":$PATH:" in *":/usr/sbin:"*) ;; *) PATH="$PATH:/usr/sbin" ;; esac
case ":$PATH:" in *":/sbin:"*) ;; *) PATH="$PATH:/sbin" ;; esac
export PATH
OC="${OPENCODE_BIN:-$(command -v opencode || true)}"
# The TUI's binary must be an absolute path: tmux runs a login shell whose PATH
# may not carry it, and a missing OPENCODE_BIN turns the run into an install
# prompt instead of a TUI (measured: the pane showed the install hint).
if [ -z "$OC" ] || [ ! -x "$OC" ]; then
  for candidate in "$HOME/.opencode/bin/opencode" /usr/local/bin/opencode /opt/homebrew/bin/opencode; do
    [ -x "$candidate" ] && { OC="$candidate"; break; }
  done
fi
if [ -z "$OC" ] || [ ! -x "$OC" ]; then
  echo "✗ no opencode v2 binary found (set OPENCODE_BIN)" >&2
  exit 1
fi
WORK="$(mktemp -d)"
ART="$HERE/.artifacts/agent-matrix"
mkdir -p "$ART"

# ---------------------------------------------------------------- config isolation
# ★ The TUI reads `~/.config/opencode/opencode.json` unless `OPENCODE_CONFIG_DIR` points
# elsewhere. `e2e-real-tui.sh` has isolated it since docs/E2E-PITFALLS.md #8; this matrix
# never did, so every cell was graded against THE OPERATOR'S config — including the model
# that config selects — and a difference there read as a difference between opencode
# releases. Measured: without isolation `opencode acp` "failed" identically on 2.0.32,
# 2.1.4, 2.2.7 and 2.3.2; with it the same cell passes on 2.1.4 (8/8). A harness that
# measures the operator reports the operator's setup as a property of the software.
#
# No provider block is copied in. With a private directory the agent advertises its own
# models (measured: 13, `currentValue` `opencode/tidepool-alpha-free`), which is all a cell
# needs to have something to select — and copying the operator's provider would put their
# account back inside the thing being measured.
#
# ONE escape hatch, for deliberately reproducing an operator's environment:
# `USE_REAL_TUI_CONFIG=1`. There is no `SKIP_*` switch — a skip switch means "the default
# stays wrong and you must remember the incantation".
TUI_CONFIG_DIR="$WORK/tui-config"
mkdir -p "$TUI_CONFIG_DIR"
# v2.3.0 moved CLI config from `tui.json` to `cli.json` (`tui.json` is read only to migrate),
# so both are written for releases either side of the change — same as `e2e-real-tui.sh`.
printf '{"session":{"verbosity":"high"}}\n' >"$TUI_CONFIG_DIR/cli.json"
printf '{"session":{"verbosity":"high"}}\n' >"$TUI_CONFIG_DIR/tui.json"
if [ "${USE_REAL_TUI_CONFIG:-0}" = "1" ]; then
  echo "  ! USE_REAL_TUI_CONFIG=1: cells read the operator's own ~/.config/opencode — a verdict" >&2
  echo "    from this run is about that configuration, NOT about the version under test" >&2
  unset OPENCODE_CONFIG_DIR
else
  export OPENCODE_CONFIG_DIR="$TUI_CONFIG_DIR"
fi
ONLY="${ONLY:-claude,codex,opencode,dsh-acp,qwen,gemini}"
FAILED=0
BLOCKED=0
PASSED=0

note() { echo "  · $1"; }
ok() { echo "  ✓ $1"; PASSED=$((PASSED + 1)); }
fail() {
  echo "  ✗ $1" >&2
  FAILED=$((FAILED + 1))
}
blocked() {
  echo "  ⊘ blocked: $1" >&2
  BLOCKED=$((BLOCKED + 1))
}

cleanup() {
  for name in $(tmux ls 2>/dev/null | grep -oE '^matrix-[a-z0-9]+'); do tmux kill-session -t "$name" 2>/dev/null; done
  # `KEEP=1` leaves the per-agent maps and logs in place — the only way to answer "was the
  # session in the map?" after a cell reported that no session was named this run.
  if [ "${KEEP:-0}" = "1" ]; then
    echo "  (kept for post-mortem: $WORK)" >&2
  else
    rm -rf "$WORK"
  fi
}
trap cleanup EXIT

# one cell: name, agent command, expected model fragment (grep, case-insensitive),
# extra env (temp HOME etc., may be empty), and the expected turn outcome —
# "reply" (text renders) or "error" (the agent's own error renders).
cell() {
  local name="$1" agent="$2" model="$3" extra_env="$4" outcome="$5"
  local dir="$WORK/$name"
  local map="$WORK/$name-map.json"
  local log="$ART/$name.log"
  local session="matrix-$name"
  mkdir -p "$dir"
  echo "▸ $name — $agent"

  # The bridge launches the TUI itself (the single-entry path the owner uses);
  # the agent's cwd is a throwaway directory so no real workspace is touched.
  cat >"$WORK/$name.sh" <<EOF
#!/bin/bash
cd "$dir"
exec env $extra_env ${OPENCODE_CONFIG_DIR:+OPENCODE_CONFIG_DIR="$OPENCODE_CONFIG_DIR"} OPENCODE_ACP_CLIENT_SESSION_MAP="$map" OPENCODE_BIN="$OC" node "$HERE/dist/index.js" --bridge-log "$log" -- $agent
EOF
  chmod +x "$WORK/$name.sh"
  tmux kill-session -t "$session" 2>/dev/null
  tmux new-session -d -s "$session" -x 130 -y 42 "$WORK/$name.sh"
  tmux set-option -t "$session" remain-on-exit on 2>/dev/null

  # 1. the TUI comes up with THIS agent's identity in the footer
  # ★ v2.3.0 shows a "What's new in <version>" dialog on the FIRST launch of a version, and it
  # holds the composer until dismissed. Measured here on three agents at once
  # (opencode / dsh-acp / gemini): the pane held "What's new in 2.2.7" and `Ask anything` never
  # appeared, so all three were reported as "the TUI never became ready" — a startup bug that
  # did not exist. Same fix as scripts/e2e-real-tui.sh: dismiss inside the wait, bounded, so it
  # cannot fight a dialog the mode itself is driving.
  local up=0 dismissed=0
  for _ in $(seq 1 90); do
    sleep 1
    tmux capture-pane -p -t "$session" 2>/dev/null | grep -q 'Ask anything' && {
      up=1
      break
    }
    if [ "$dismissed" -lt 2 ] \
       && tmux capture-pane -p -t "$session" 2>/dev/null | grep -qE "What's new in|scroll ↑/↓.*ok"; then
      tmux send-keys -t "$session" Enter 2>/dev/null || true
      dismissed=$((dismissed + 1))
    fi
  done
  if [ "$up" != 1 ]; then
    save_pane "$name" "$session"
    fail "$name: the TUI never became ready"
    tmux kill-session -t "$session" 2>/dev/null
    return
  fi
  ok "$name: TUI up"

  # 2. the footer names the agent and a REAL model (the placeholder is `acp`)
  local pane model_ok=0
  for _ in $(seq 1 40); do
    pane="$(tmux capture-pane -p -t "$session" 2>/dev/null)"
    printf '%s' "$pane" | grep -qi "$model" && {
      model_ok=1
      break
    }
    sleep 1
  done
  if [ "$model_ok" = 1 ]; then
    ok "$name: footer shows the real model ($(printf '%s' "$pane" | grep -oiE '[A-Za-z0-9()./ _-]*'"$model"'[A-Za-z0-9()./ _-]*' | head -1 | sed 's/^ *//'))"
  else
    note "$name: expected model fragment '$model' not on screen (continuing — the turn is the real test)"
  fi

  # 3. one turn, asserted on the SCREEN
  tmux send-keys -t "$session" "Reply with exactly: MATRIX_OK"
  sleep 1.6
  tmux send-keys -t "$session" Enter
  # ★ The turn's OUTCOME, decided from the screen before it is graded. `dead` is
  # new and separate on purpose (measured 2026-11-22, gemini): the old single test
  # was `grep -q 'MATRIX_OK\|Authentication required\|Error:'`, and OUR OWN bridge
  # error row reads `Error: could not start the agent: agent exited: ACP connection
  # closed` — so a cell whose agent process had died before the turn was graded
  # "the reply rendered on screen". A dead agent is neither a reply nor the agent's
  # own credentials: it is a failure, and it must never be able to match the broad
  # `Error:` arm, so it is tested FIRST and the match is required to be an outcome
  # we did not write.
  # ★ ORDER MATTERS, and it cost a whole run to learn (measured 2026-11-22, qwen and gemini
  # on opencode v2.1.4): the reply test comes FIRST, the busy test second, the dead test
  # third. The earlier order (hint first, reply inside `if ! hint`) reported three cells as
  # "the turn never finished (esc interrupt still up after ~4min)" while the saved panes,
  # captured 2 s later, held ZERO `esc interrupt` (1856 bytes for qwen): the hint is one row
  # and scrolls out of a 42-row pane once the error row wraps, so a FINISHED turn never
  # satisfied the terminator and the loop ran its full 150x2 s. The other order (dead first)
  # is just as wrong: `grep 'agent exited'` matches the TUI's own last words in the history
  # (`the TUI exited, shutting down`), so a healthy agent was graded `dead`.
  local done_turn=0 dead=0 quiet=0 body=''
  for _ in $(seq 1 150); do
    sleep 2
    body="$(tmux capture-pane -p -t "$session" 2>/dev/null)"
    # 1. The agent's own answer, with the echo of the prompt we typed excluded.
    if printf '%s' "$body" | grep -v "Reply with exactly" | grep -q 'MATRIX_OK\|Authentication required'; then
      done_turn=1
      break
    fi
    # 2. Still busy: wait. The hint's ABSENCE is not a verdict — it scrolls.
    printf '%s' "$body" | grep -q 'esc interrupt' && continue
    # 3. Our own bridge error: the agent process never came up.
    if printf '%s' "$body" | grep -q 'could not start the agent\|agent exited'; then
      dead=1
      break
    fi
    # 4. Not busy, no reply, no error: stop after 30 s and grade it "no reply" below.
    quiet=$((quiet + 1))
    if [ "$quiet" -ge 15 ]; then
      break
    fi
  done
  save_pane "$name" "$session"
  if [ "$dead" = 1 ]; then
    # Corroborate on the log: the bridge prints `[acp] agent exited code=…` from its
    # own child-process handler, which is independent of anything we rendered.
    local reason
    reason="$(grep -ao 'could not start the agent[^\n]*\|agent exited[^\n]*' <<<"$body" | head -1)"
    if grep -aq 'agent exited code=' "$log" 2>/dev/null; then
      fail "$name: the agent process did not come up ($reason; bridge log: $(grep -ao 'agent exited code=[0-9]*' "$log" | head -1)) — no turn was possible, so nothing else on this screen is evidence"
    else
      fail "$name: the agent process did not come up ($reason) — no turn was possible"
    fi
    tmux kill-session -t "$session" 2>/dev/null
    return
  fi
  if [ "$done_turn" != 1 ]; then
    # ★ Report what was observed. The old message asserted "esc interrupt still up", which was
    # measurably false for every cell it cost a run — a failure that misdiagnoses itself.
    local busy=no
    printf '%s' "$body" | grep -q 'esc interrupt' && busy=yes
    fail "$name: the turn produced no visible outcome in ~5min (TUI busy: $busy)"
    tmux kill-session -t "$session" 2>/dev/null
    return
  fi
  ok "$name: the turn ran to completion"

  case "$outcome" in
  reply)
    # ★ The prompt we typed ourselves is on screen too, so its echo must not count
    # as the agent's answer: `grep -v "Reply with exactly"` drops the composer and
    # the user row, and what remains is the agent's own text.
    if printf '%s' "$body" | grep -v "Reply with exactly" | grep -q 'MATRIX_OK'; then
      ok "$name: the reply rendered on screen"
    else
      fail "$name: no reply text on screen"
    fi
    ;;
  error)
    # The agent's own credentials/API are broken in this environment. Two shapes
    # are both acceptable evidence that OUR side carried it right:
    #   (a) the agent's ERROR reached the transcript (rendered on screen), or
    #   (b) the agent failed before the turn could start — its own adapter log
    #       says so (codex measured: `401 Unauthorized` from its websocket) —
    #       and the bridge carried the session-creation failure faithfully.
    # ★ Our own row is excluded first: `Error: could not start the agent: agent
    # exited: …` is the bridge reporting a DEAD PROCESS, which is not the agent's
    # credentials. Matching it here turned a dead agent into a BLOCKED cell — the
    # same false positive as the `reply` arm, one word over.
    local agent_error
    agent_error="$(printf '%s' "$body" | grep -v 'could not start the agent' | grep -oiE '(Error|Authentication)[^\n]{0,60}' | grep -viE 'agent exited|ACP connection closed' | head -1)"
    if [ -n "$agent_error" ]; then
      blocked "$name: the agent's own error rendered ($agent_error)"
    elif grep -qiE '401 Unauthorized|Authentication required|unauthorized|invalid api key' "$log" 2>/dev/null; then
      blocked "$name: the agent's own credential failure ($(grep -oiE '401 Unauthorized|Authentication required[^,]*|invalid api key' "$log" | head -1)) — it never reached a turn, so the screen has nothing to render"
    else
      fail "$name: expected the agent's own error on screen, saw none"
    fi
    ;;
  esac

  # ★ An agent that cannot authenticate never had a turn to check anything else with: there is
  # no session to bind, so "the Continue line is opencode's native one" and the feature checks
  # below would all fail for one reason — the agent's missing credential. Measured on a Debian
  # box where none of the dsh profiles had a provider key: the error screen was correct, then
  # the cell still reported six feature failures plus a Continue-line failure.
  #
  # Declared per cell: a cell expects a real turn (`reply`) or expects the agent's own error
  # (`error`). When an `error` cell finds the agent's message, this is the end of the cell.
  if [ "$outcome" = "error" ] \
     && printf '%s' "$body" | grep -qiE 'Authentication required|no credential found|401 Unauthorized'; then
    tmux kill-session -t "$session" 2>/dev/null
    return
  fi

  # 3b. the product's own features, the ones `e2e-dsh-acp.sh` proves in depth for one
  # agent. They cost NO model tokens: `!command` runs locally, `/model` reads the
  # catalog the agent already advertised, and the unsupported-verb probe is answered
  # by the bridge itself. They must run BEFORE the exit below: sending them after
  # `C-c` typed into a dead pane and reported "!command showed no output" — the probe
  # was wrong, not the product.
  feature_probes "$name" "$session"

  # 4. the exit epilogue names OUR command (the owner's rewrite), not `opencode`.
  # Wait until the bridge has SEEN the prompt: the TUI can still be settling a
  # model switch when the reply looks done, and exiting then means the bridge
  # never logged a prompted session (measured: dsh's window showed /model 204
  # and no prompt request at all).
  for _ in $(seq 1 60); do
    grep -q 'POST /api/session/[^ ]*/prompt' "$log" 2>/dev/null && break
    sleep 0.5
  done
  if ! grep -q 'POST /api/session/[^ ]*/prompt' "$log" 2>/dev/null; then
    # An agent whose credentials are broken can refuse before any prompt is
    # accepted; the error evidence below still decides the cell.
    note "$name: the bridge saw no prompt request (the agent may have refused first)"
  fi
  sleep 3
  tmux send-keys -t "$session" C-c
  sleep 2
  tmux send-keys -t "$session" C-c
  # ★ Wait for the epilogue to be WRITTEN, not for a fixed 4s. The rewrite is attached to the
  # child's 'close' event (not 'exit'), so it prints only after the TUI's stdio has drained —
  # and scripts/e2e-epilogue.sh waits for exactly this marker in the log. Measured: this cell
  # reported "the Continue line is opencode's native one" while the line our rewrite produces
  # simply had not been printed yet.
  for _ in $(seq 1 20); do
    grep -q 'epilogue ' "$log" 2>/dev/null && break
    sleep 1
  done
  sleep 2
  local tail_pane
  tail_pane="$(tmux capture-pane -p -t "$session" 2>/dev/null)"
  save_pane "$name-exit" "$session"
  if printf '%s' "$tail_pane" | grep -qE 'Continue.*oc-acp-client|Continue.*dist/index\.js'; then
    ok "$name: the Continue line is ours"
  elif printf '%s' "$tail_pane" | grep -q 'Continue.*opencode -s'; then
    fail "$name: the Continue line is opencode's native one (the rewrite did not run)"
  else
    note "$name: no Continue line captured (the agent may have exited without a session route)"
  fi
  tmux kill-session -t "$session" 2>/dev/null
}

# The probes every agent gets, on the screen. Kept separate from `cell` so the
# turn assertions stay readable, and deliberately token-free: a matrix over eight
# agents must not cost eight conversations.
# Empty the composer. `C-u` would kill a line but the TUI's composer can hold a
# multi-line draft, so press it on every line we can see and then confirm on screen.
clear_composer() {
  local session="$1"
  local i pane
  for i in $(seq 1 12); do
    pane="$(tmux capture-pane -p -t "$session" 2>/dev/null)"
    # A composer holding text shows the draft above the footer; the footer's own line
    # starts with the directory. Stop when nothing but chrome is left.
    printf '%s' "$pane" | grep -qE 'Reply with exactly: MATRIX_OK|SHELLIN|/btw|^\s*$' || return 0
    printf '%s' "$pane" | grep -q 'Reply with exactly: MATRIX_OK' || break
    tmux send-keys -t "$session" C-u
    sleep 0.3
  done
  return 0
}

feature_probes() {
  local name="$1" session="$2"
  local pane

  # (a) `!command` — the shell card. Nothing to do with the agent, so a failure here
  # is always ours, which makes it the most valuable probe in the matrix.
  #
  # Clear the composer first. The TUI leaves the last prompt's text behind after some
  # agents' turns (measured with codex: the pane showed
  # `Reply with exactly: MATRIX_OK!echo SHELLIN | tr A-Z a-z`), so the `!` was appended
  # to stale text and became part of a prompt instead of starting a shell line —
  # reported as "!command showed no output" while the product was fine.
  clear_composer "$session"
  tmux send-keys -t "$session" "!echo SHELLIN | tr A-Z a-z"
  sleep 1.4
  tmux send-keys -t "$session" Enter
  local shell_ok=0
  for _ in $(seq 1 20); do
    sleep 1
    pane="$(tmux capture-pane -p -t "$session" 2>/dev/null)"
    printf '%s' "$pane" | grep -q 'shellin' && { shell_ok=1; break; }
  done
  save_pane "$name-shell" "$session"
  if [ "$shell_ok" = 1 ]; then
    ok "$name: !command rendered its output"
  else
    fail "$name: !command showed no output"
  fi

  # (b) `/model` — the catalog the agent advertised. Only the OPENING is asserted:
  # the list content belongs to the agent (some advertise one model), and picking
  # from it would spend a turn.
  clear_composer "$session"
  tmux send-keys -t "$session" "/model"
  sleep 1.2
  tmux send-keys -t "$session" Enter
  local model_ok=0
  for _ in $(seq 1 20); do
    sleep 1
    pane="$(tmux capture-pane -p -t "$session" 2>/dev/null)"
    printf '%s' "$pane" | grep -qiE 'select model|models' && { model_ok=1; break; }
  done
  save_pane "$name-models" "$session"
  if [ "$model_ok" = 1 ]; then
    ok "$name: /model opened the agent's catalog"
  else
    note "$name: /model showed no list (the agent may advertise no config options)"
  fi
  tmux send-keys -t "$session" Escape
  sleep 0.8

  # (c) a verb the bridge cannot honour must fail as a DECLARED status, never as
  # `UnexpectedStatus` (that string is what the TUI prints for a status its client
  # does not expect, and it once appeared on every cancel).
  clear_composer "$session"
  tmux send-keys -t "$session" "/btw matrix probe"
  sleep 1.2
  tmux send-keys -t "$session" Enter
  sleep 4
  pane="$(tmux capture-pane -p -t "$session" 2>/dev/null)"
  save_pane "$name-verb" "$session"
  if printf '%s' "$pane" | grep -q 'UnexpectedStatus'; then
    fail "$name: /btw produced UnexpectedStatus (an undeclared status was answered)"
  else
    ok "$name: an unhonourable verb failed without UnexpectedStatus"
  fi
}

save_pane() {
  local label="$1" session="$2"
  tmux capture-pane -p -t "$session" >"$ART/$label.txt" 2>/dev/null || true
}

# ---------------------------------------------------------------- the cells
# Both adapters are run from the owner's local checkouts when they are built
# (`../codex-acp`, `../claude-agent-acp`), because that is the code the owner asked us
# to cover; `npx -y <package>` is the fallback so the matrix still runs on a machine
# without those checkouts.
CODEX_ACP_RUN="npx -y @agentclientprotocol/codex-acp"
if [ -f "$HERE/../codex-acp/dist/index.js" ]; then
  CODEX_ACP_RUN="node $HERE/../codex-acp/dist/index.js"
fi
CLAUDE_ACP_RUN="npx -y @agentclientprotocol/claude-agent-acp"
if [ -f "$HERE/../claude-agent-acp/dist/index.js" ]; then
  CLAUDE_ACP_RUN="node $HERE/../claude-agent-acp/dist/index.js"
fi

if [[ ",$ONLY," == *",claude,"* ]]; then
  cell claude "$CLAUDE_ACP_RUN" "Claude" "" reply
fi

if [[ ",$ONLY," == *",codex,"* ]]; then
  # codex's own model catalog rejects `"effort": "max"` at startup; a temp HOME
  # with that value corrected keeps the owner's ~/.codex untouched.
  CODEX_HOME="$WORK/codex-home"
  mkdir -p "$CODEX_HOME/.codex"
  cp "$HOME"/.codex/*.json "$CODEX_HOME/.codex/" 2>/dev/null || true
  python3 - "$CODEX_HOME/.codex" <<'PY'
import glob, sys
for f in glob.glob(sys.argv[1] + '/*.json'):
    text = open(f).read()
    if '"effort": "max"' in text:
        open(f, 'w').write(text.replace('"effort": "max"', '"effort": "xhigh"'))
PY
  cell codex "$CODEX_ACP_RUN" "Codex" "HOME=$CODEX_HOME" reply
fi

# `opencode acp` used to be the one cell expected to be BLOCKED: the ACP subcommand
# carried no provider credentials and answered "Authentication required". Once the
# owner's Ark plan was configured it answers normally (measured 2026-11-05: the pane
# showed `MATRIX_OK` and a real `agent-plan/...` model), so the cell asserts a real
# reply like the others. A machine without those credentials still reports BLOCKED —
# that path is kept by the `error` outcome of the codex/claude cells.
if [[ ",$ONLY," == *",opencode,"* ]]; then
  cell opencode "$OC acp" "OpenCode" "" reply
fi

# dsh's built-in ACP entry point (`--profile acp`): the official server speaks the same
# protocol surface with dsh's own defaults, so it is a separate cell, not an alias.
if [[ ",$ONLY," == *",dsh-acp,"* ]] && command -v dsh >/dev/null 2>&1; then
  cell dsh-acp "dsh --profile acp" "Deepseek" "" reply
fi

# qwen and gemini ship their own ACP entry points (`--acp`), so they need no
# adapter package. Both print startup noise on stderr before the protocol starts
# (gemini warns about an untrusted folder and a skill conflict); the bridge reads
# stdout only, which is where the JSON-RPC lives.
if [[ ",$ONLY," == *",qwen,"* ]] && command -v qwen >/dev/null 2>&1; then
  cell qwen "qwen --acp" "Qwen" "" reply
fi

if [[ ",$ONLY," == *",gemini,"* ]] && command -v gemini >/dev/null 2>&1; then
  cell gemini "gemini --acp" "Gemini" "" reply
fi

# ---------------------------------------------------------------- verdict
echo
if [ "$FAILED" -gt 0 ]; then
  echo "✗ agent matrix: $FAILED failure(s), $BLOCKED blocked by the agent, $PASSED check(s) passed" >&2
  echo "  panes: $ART" >&2
  exit 1
fi
echo "✓ agent matrix passed: $PASSED check(s), $BLOCKED blocked by the agents' own credentials/config"
echo "  panes: $ART"
