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
ONLY="${ONLY:-claude,codex,opencode,dsh,dsh-acp,qwen,gemini}"
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
exec env $extra_env OPENCODE_ACP_CLIENT_SESSION_MAP="$map" OPENCODE_BIN="$OC" node "$HERE/dist/index.js" --bridge-log "$log" -- $agent
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
  local done_turn=0 body=''
  for _ in $(seq 1 150); do
    sleep 2
    body="$(tmux capture-pane -p -t "$session" 2>/dev/null)"
    # ★ Both conditions, not just the hint: the interrupt hint can vanish
    # while the turn is still settling (measured: the bridge logged the prompt,
    # then the epilogue, with no turn work between — the script had exited on
    # the hint alone). A turn is over when the hint is gone AND the outcome is
    # on screen: reply text, or the agent's own error.
    if ! printf '%s' "$body" | grep -q 'esc interrupt'; then
      if printf '%s' "$body" | grep -q 'MATRIX_OK\|Authentication required\|Error:'; then
        done_turn=1
        break
      fi
    fi
  done
  save_pane "$name" "$session"
  if [ "$done_turn" != 1 ]; then
    fail "$name: the turn never finished (esc interrupt still up after ~4min)"
    tmux kill-session -t "$session" 2>/dev/null
    return
  fi
  ok "$name: the turn ran to completion"

  case "$outcome" in
  reply)
    if printf '%s' "$body" | grep -q 'MATRIX_OK'; then
      ok "$name: the reply rendered on screen"
    else
      fail "$name: no reply text on screen"
    fi
    ;;
  error)
    # The agent's own credentials/API are broken in this environment. Two shapes
    # are both acceptable evidence that OUR side carried it right:
    #   (a) the agent's error reached the transcript (rendered on screen), or
    #   (b) the agent failed before the turn could start — its own adapter log
    #       says so (codex measured: `401 Unauthorized` from its websocket) —
    #       and the bridge carried the session-creation failure faithfully.
    if printf '%s' "$body" | grep -qiE 'Authentication required|Error:'; then
      blocked "$name: the agent's own error rendered ($(printf '%s' "$body" | grep -oiE '(Error|Authentication)[^\n]{0,60}' | head -1))"
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
