#!/usr/bin/env bash
#
#
# Contract/trigger: the `Continue …` line the real TUI prints on exit, and the
#   session name it offers. Run for anything touching the exit path or titles.
# Boundary: real opencode v2 TUI in tmux -> bridge; the pane is the oracle.
# Oracles: `tmux capture-pane` text, plus the bridge's session read.
# Negative controls: a restored tab keeps its real name (no marker), the line
#   ends with exactly one newline, and our own wordmark replaces the native one.
## The exit epilogue, asserted on the SCREEN of a real opencode v2 TUI.
#
# Why this exists: the `Continue …` line the user copies out of the TUI is the
# only handoff from "a conversation I had" to "the same conversation again", and
# it is written by the *client*, not by us. Three of the owner's reports were
# exactly this line being wrong:
#
#   1. resumed a session, typed nothing, quit  → the line kept the TUI's native
#      `opencode -s <id>`, which resumes nothing this product knows;
#   2. several restored tabs                  → the line named a DIFFERENT tab
#      than the one the user had resumed;
#   3. the rewrite "did not work"             → the line was too long to fit and
#      the old code abandoned it silently.
#
# A unit test can only cover the ordering of the three id sources (they are a
# pure function, see `tests/client-args.test.ts`). Whether the line actually
# lands on the terminal after the TUI exits is a rendering fact, so it is
# asserted here: real TUI, tmux, `capture-pane` (AGENTS.md iron rule 7).
#
# No model tokens are spent: the agent is `tests/fake-acp-agent.mjs` with
# `FAKE_ACP_CAPS_RESUME=1`, so a `--session` resume succeeds the way the backend's
# plain ACP profile does (context continues, history is not replayed).
#
# Usage:
#   bash scripts/e2e-epilogue.sh
#   OC=/path/to/opencode bash scripts/e2e-epilogue.sh
#
# Needs: tmux, node, dist/ (run `pnpm build` first), a real opencode v2 binary.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"
OC="${OC:-$HOME/.opencode/bin/opencode}"
if [ ! -x "$OC" ]; then
  OC="$(command -v opencode || true)"
fi
if [ -z "$OC" ] || [ ! -x "$OC" ]; then
  echo "✗ no opencode v2 binary found (set OC=/path/to/opencode)" >&2
  exit 1
fi
if [ ! -f dist/index.js ]; then
  echo "✗ dist/index.js is missing — run 'pnpm build' first" >&2
  exit 1
fi

WORK="$(mktemp -d)"
ART="$REPO/.artifacts/epilogue"
mkdir -p "$ART"
PASSED=0
FAILED=0
NOTED=0

note() {
  echo "  · $1"
  NOTED=$((NOTED + 1))
}
ok() { echo "  ✓ $1"; PASSED=$((PASSED + 1)); }
fail() {
  echo "  ✗ $1" >&2
  FAILED=$((FAILED + 1))
}

cleanup() {
  for name in $(tmux ls 2>/dev/null | grep -oE '^epilogue-[a-z0-9]+'); do
    tmux kill-session -t "$name" 2>/dev/null
  done
  rm -rf "$WORK"
}
trap cleanup EXIT

# A private HOME per case: `isolatedTuiRoots()` builds the TUI's XDG roots from
# `homedir()`, and the tab-restore cases have to seed that root's `tabs.json` —
# writing into the owner's real one would clobber their actual tab layout. HOME
# also isolates the session map, so no case can see another's ids.
#
# seed_map <home> <directory> <visible>=<agent> [<visible>=<agent> …]
export EPILOGUE_FAKE_AGENT="$REPO/tests/fake-acp-agent.mjs"
seed_map() {
  local home="$1" dir="$2"
  shift 2
  mkdir -p "$home/.opencode-acp-client"
  python3 - "$home/.opencode-acp-client/sessions.json" "$dir" "$@" <<'PY'
import json, os, sys, time
path, directory, pairs = sys.argv[1], sys.argv[2], sys.argv[3:]
now = int(time.time() * 1000)
# ★ Every entry must name the agent that created it. A bridge that reads an entry WITHOUT
# the binding refuses it (404) on purpose — its owner is unknown — so a seeded entry that
# omitted this made the restored tab 404 and the epilogue name nothing (measured: this
# suite failed exactly that way after the field was introduced).
binding = {"command": "node", "args": [os.environ["EPILOGUE_FAKE_AGENT"]]}
entries = {}
for pair in pairs:
    visible, agent = pair.split("=", 1)
    entries[visible] = {
        "acpSessionId": agent,
        "directory": directory,
        "agent": binding,
        "updatedAt": now,
    }
json.dump(entries, open(path, "w"), indent=2)
PY
}

# Pre-write the TUI's remembered tab layout, which is what makes it hydrate a
# session the user did not name on the command line. ★ The shape must match what
# the client itself writes — `{global:{…}, cwd:{<dir>:{tabs:[…]}}}` — because a
# hand-made shape that merely looks plausible makes the TUI CRASH on startup
# (`TypeError: undefined is not an object (evaluating 'g.cwd[u.cwd]')`), which
# looks exactly like "our bridge broke the client" until you read the file.
seed_tabs() {
  local home="$1" workspace="$2" session="$3"
  # ★ One client = one agent: the TUI's tab layout lives under a root named after
  # the agent command (agentStateSlug). Seeding the old shared root made the TUI
  # start with an empty tab list and never hydrate the seeded session (measured:
  # the epilogue then named nothing). The slug must use the SAME binding the map
  # records: {"command":"node","args":[<fake agent>]}.
  local slug
  slug="$(cd "$REPO" && node -e '
    const {createHash}=require("node:crypto"); const {basename}=require("node:path");
    const command="node", args=[process.argv[1]];
    const runner=basename(command);
    const script=["node","bun","deno","python","python3","npx"].includes(runner)&&args[0]
      ? basename(args[0]).replace(/\.[^.]+$/,"") : undefined;
    const words=`${script??runner}-${(script?args.slice(1):args).join("-")}`
      .replace(/[^a-zA-Z0-9._-]+/g,"-").replace(/-+/g,"-").replace(/^-|-$/g,"").slice(0,40);
    const hash=createHash("sha256").update(JSON.stringify([command,...args])).digest("hex").slice(0,8);
    console.log(`${words||"agent"}-${hash}`);
  ' "$EPILOGUE_FAKE_AGENT")"
  local dir="$home/.opencode-acp-client/opencode/$slug/state/opencode/latest/tui"
  mkdir -p "$dir"
  python3 - "$dir/tabs.json" "$workspace" "$session" <<'PY'
import json, sys
path, workspace, session = sys.argv[1:4]
json.dump(
    {
        "global": {"tabs": [], "unread": {}},
        "cwd": {workspace: {"tabs": [{"sessionID": session, "title": "restored-other-tab"}], "unread": {}}},
    },
    open(path, "w"),
    indent=2,
)
PY
}

# Make the bridge believe the client looked at another session after the fact.
# `POST /api/session/:id/view` is the surface's own focus signal (the desktop
# client posts it; the shipped TUI stopped sending it in v2.0.32). Case 2 needs
# the signal to come from a DIFFERENT session than the one asked for — with the
# client hydrating everything, whether it happens to read that session's singular
# route is timing, and a test that only sometimes creates the conflict proves
# nothing.
inject_view() {
  local log="$1" session="$2"
  local url
  url="$(sed -n 's/.*--server \(http:\/\/[^ ]*\).*/\1/p' "$log" | head -1)"
  if [ -z "$url" ]; then
    return 1
  fi
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$url/api/session/$session/view" \
    -H 'content-type: application/json' -d '{"idle":1}')"
  [ "$code" = "200" ] || [ "$code" = "204" ]
}

# One case:
#   run_case <name> <home> <workspace> <extra env> <argv> <wanted id|*|-> <wait needle>
# `wait needle` is a fixed string looked for in the bridge log — the reliable "the
# client reached a session route" signal. Empty = wait for the composer instead.
run_case() {
  local name="$1" home="$2" dir="$3" extra_env="$4" argv="$5" want="$6" needle="$7"
  local session="epilogue-$name"
  local log="$ART/$name.log"
  local script="$WORK/$name.sh"
  # A failed launch that returns early must not leave the previous run's screen
  # behind for the assertions to read (measured: stale ✓s from a 19:05 run).
  rm -f "$ART/$name-before.txt" "$ART/$name-after.txt" "$ART/$name-noup.txt"
  : >"$log"
  # `-s`/`-c` take no agent: the session map fixes it. A new session still does.
  local resume=0
  case " $argv " in
    *" -s "*|*" --session "*|*" -c "*|*" --continue "*) resume=1 ;;
  esac
  if [ "$resume" = 1 ]; then
    cat >"$script" <<EOF
#!/bin/bash
cd "$dir"
exec env HOME="$home" $extra_env OPENCODE_BIN="$OC" node "$REPO/dist/index.js" --bridge-log "$log" $argv
EOF
  else
    cat >"$script" <<EOF
#!/bin/bash
cd "$dir"
exec env HOME="$home" $extra_env OPENCODE_BIN="$OC" node "$REPO/dist/index.js" --bridge-log "$log" $argv -- node "$REPO/tests/fake-acp-agent.mjs"
EOF
  fi
  chmod +x "$script"

  tmux kill-session -t "$session" 2>/dev/null
  tmux new-session -d -s "$session" -x 130 -y 42 "$script"
  tmux set-option -t "$session" remain-on-exit on 2>/dev/null

  local up=0
  for _ in $(seq 1 60); do
    sleep 1
    if [ -n "$needle" ]; then
      grep -qF -- "$needle" "$log" 2>/dev/null && {
        up=1
        break
      }
    else
      tmux capture-pane -p -t "$session" 2>/dev/null | grep -q 'Ask anything' && {
        up=1
        break
      }
    fi
  done
  if [ "$up" != 1 ]; then
    tmux capture-pane -p -t "$session" >"$ART/$name-noup.txt" 2>/dev/null
    fail "$name: the TUI never reached a session route"
    tmux kill-session -t "$session" 2>/dev/null
    return
  fi
  ok "$name: the client is up and in a session"

  # Let the first frame settle before capturing what the user would see.
  sleep 2
  tmux capture-pane -p -t "$session" >"$ART/$name-before.txt" 2>/dev/null

  # A case may need to change the world while the client is up (e.g. mark a
  # DIFFERENT session as viewed), so the hook runs here — after the first frame,
  # before the quit that triggers the epilogue.
  if [ -n "${HOOK:-}" ]; then
    "$HOOK" "$name" "$log" "$session"
  fi

  # Quit the way a user does: Ctrl-C twice (the first press arms the interrupt,
  # the second leaves — measured in scripts/e2e-agent-matrix.sh).
  tmux send-keys -t "$session" C-c
  sleep 2
  tmux send-keys -t "$session" C-c
  # ★ Capture the screen BEFORE waiting for the decision. The pane dies with the TUI: once the
  # bridge has finished, `tmux capture-pane` answers "no server running" and the file is 0
  # bytes — measured on Debian with opencode v2.2.0, where the bridge log said
  # "epilogue rewritten: Continue node …/dist/index.js -s ses_…" and every screen assertion
  # still failed because there was no screen left to read.
  #
  # Both loops run together: poll the log for the decision, and poll the pane for a
  # `Continue` line, until one of them stops producing frames.
  local gone=0
  for _ in $(seq 1 60); do
    sleep 0.5
    tmux capture-pane -p -t "$session" >"$ART/$name-after.txt" 2>/dev/null
    grep -qE '^ *Continue ' "$ART/$name-after.txt" 2>/dev/null && break
    tmux has-session -t "$session" 2>/dev/null || break
  done
  for _ in $(seq 1 30); do
    grep -q 'epilogue ' "$log" 2>/dev/null && {
      gone=1
      break
    }
    sleep 0.5
  done
  if [ "$gone" != 1 ]; then
    fail "$name: the bridge never reached its epilogue decision after quitting"
    tmux kill-session -t "$session" 2>/dev/null
    return
  fi
  # The decision line is written after the rewrite; take a second look now that it is there,
  # in case the first capture raced the bridge's own output flush.
  if ! grep -qE '^ *Continue ' "$ART/$name-after.txt" 2>/dev/null; then
    for _ in $(seq 1 10); do
      sleep 0.5
      tmux capture-pane -p -t "$session" >"$ART/$name-after.txt" 2>/dev/null
      grep -qE '^ *Continue ' "$ART/$name-after.txt" && break
      tmux has-session -t "$session" 2>/dev/null || break
    done
  fi

  # ── what the bridge decided, and what the user can see ────────────────────
  local decision line
  decision="$(grep 'epilogue ' "$log" | tail -1)"
  note "$name: bridge: ${decision#\[bridge\] }"
  line="$(grep -E '^ *Continue ' "$ART/$name-after.txt" | tail -1)"
  [ -n "$line" ] && note "$name: screen:${line}"

  if printf '%s' "$decision" | grep -q 'epilogue cleared'; then
    # No session to name: never invent an id. The client's own epilogue is cleared
    # instead, because on a screen with no transcript it lands on top of whatever was
    # there before the client started (measured in tmux against the native TUI).
    if [ "$want" = "-" ]; then
      ok "$name: nothing was named, and nothing was invented"
    else
      fail "$name: the bridge named no session, but '$want' was expected"
    fi
  else
    # ★ The assertion: the line names OUR launcher and the session we mean. The
    # two acceptable shapes are the full command and the narrow-terminal
    # fallback (`oc-acp-client -s <id>`) — a native `opencode -s …` is the
    # failure this whole script exists for.
    if printf '%s' "$line" | grep -q 'Continue.*opencode -s'; then
      fail "$name: the Continue line is opencode's native one (the rewrite did not run)"
    # A checkout launch prints `node <path>/dist/index.js`, an installed bin prints the
    # bin name — accept both. (The first version matched `opencode-acp-client`, which the
    # REPO PATH contains, so it was passing on the directory name; renaming the command
    # exposed that.)
    elif ! printf '%s' "$line" | grep -q 'Continue.*oc-acp-client\|Continue.*dist/index\.js'; then
      fail "$name: the Continue line names neither this product nor a resume command"
    elif [ "$want" != "*" ] && ! printf '%s' "$line" | grep -q -- "-s $want\( \|\$\)"; then
      fail "$name: the line names the wrong session (wanted '$want')"
    else
      ok "$name: the Continue line names this product and the right session"
    fi
  fi
  tmux kill-session -t "$session" 2>/dev/null
}

echo "▸ epilogue: $(basename "$OC") ($("$OC" --version 2>/dev/null | head -1))"

# ── case 1: a resume with no typing — the owner's report #1 ──────────────────
# `--session <id>` is intent, and it is the ONLY signal a quiet resume produces.
# Before this fix the line fell back to `opencode -s …`.
H1="$WORK/home-resume"
W1="$WORK/ws-resume"
mkdir -p "$W1"
W1P="$(cd "$W1" && pwd -P)"
seed_map "$H1" "$W1P" "ses_epilogue_probe=epilogue-agent-session"
run_case resume-quiet "$H1" "$W1" "FAKE_ACP_MODELS=1 FAKE_ACP_CAPS_RESUME=1" \
  "-s ses_epilogue_probe" "ses_epilogue_probe" "/api/session/ses_epilogue_probe/message"
# …and the restored tab keeps the conversation's real name: no marker, because the
# notice in the transcript explains the missing history (owner's call).
if grep -qE '\[(no history|no transcript|not resumed)\]' "$ART/resume-quiet-before.txt" 2>/dev/null; then
  fail "resume-quiet: the tab still carries a history marker"
else
  ok "resume-quiet: the tab keeps the real name (no marker)"
fi
# ★ The wordmark above the Continue line is OURS now (the TUI's four rows — the first
# all spaces — are replaced by a three-row block anchored on the Continue row), so the
# screen the user returns to names this product instead of the TUI it borrowed.
# Ours spells the whole product: the `acp client` half is the distinguishing part
# (the `opencode` glyphs are deliberately identical to the native alphabet).
if grep -qxE ' *█▀▀█ █▀▀█ █▀▀█ █▀▀▄ █▀▀▀ █▀▀█ █▀▀█ █▀▀█ *' "$ART/resume-quiet-after.txt" 2>/dev/null; then
  fail "resume-quiet: the native opencode wordmark survived the rewrite"
elif grep -q '▀▀▀█ █▀▀▀ █▀▀█' "$ART/resume-quiet-after.txt" 2>/dev/null; then
  ok "resume-quiet: the exit wordmark names this product"
else
  fail "resume-quiet: no wordmark in the post-exit screen"
fi

# ★ The reason must be ON SCREEN, not just in the title: the transcript carries a
# `Session.Message.System`, which the TUI renders as a notice row (`◈ <text>`).
# This is the assertion that proves the notice path end-to-end — JSON alone would not.
if grep -q 'no session/load capability' "$ART/resume-quiet-before.txt" 2>/dev/null; then
  ok "resume-quiet: the transcript says WHY (notice: agent has no session/load)"
else
  fail "resume-quiet: no notice in the transcript explaining the empty history"
fi

# ── case 2: intent beats a hydrated tab — the owner's report #2 ──────────────
# The client restores a remembered tab of its own and reads it, while the user
# asked for a different session — AND another session is marked as viewed after
# that, which is what a prefetch looks like from the bridge's side. The line must
# still name what was ASKED FOR: intent is not inference.
#
# (Whether the client itself reads that tab's singular route is timing; the
# conflict therefore has to be created explicitly, or the case passes without
# ever asking the question.)
hook_foreign_view() {
  if inject_view "$2" "ses_epilogue_other"; then
    ok "$1: another session was marked viewed after the request"
  else
    fail "$1: could not inject the foreign /view signal"
  fi
  sleep 1
}
H2="$WORK/home-intent"
W2="$WORK/ws-intent"
mkdir -p "$W2"
W2P="$(cd "$W2" && pwd -P)"
seed_map "$H2" "$W2P" "ses_epilogue_probe=epilogue-agent-session" "ses_epilogue_other=epilogue-other-agent"
seed_tabs "$H2" "$W2P" "ses_epilogue_other"
HOOK=hook_foreign_view
run_case intent-over-view "$H2" "$W2" "FAKE_ACP_MODELS=1 FAKE_ACP_CAPS_RESUME=1" \
  "-s ses_epilogue_probe" "ses_epilogue_probe" "/api/session/ses_epilogue_other/message"
HOOK=""

# ── case 3: a restored tab with no flag — the "viewed" fallback ──────────────
# Open the TUI, let it restore its tab, quit without typing: the hydrated session
# is all we have, and it beats leaving the native line in place (report #1's
# other half).
H3="$WORK/home-viewed"
W3="$WORK/ws-viewed"
mkdir -p "$W3"
W3P="$(cd "$W3" && pwd -P)"
seed_map "$H3" "$W3P" "ses_epilogue_other=epilogue-other-agent"
seed_tabs "$H3" "$W3P" "ses_epilogue_other"
run_case viewed-quiet "$H3" "$W3" "FAKE_ACP_MODELS=1 FAKE_ACP_CAPS_RESUME=1" \
  "" "ses_epilogue_other" "/api/session/ses_epilogue_other/message"

# ── case 4: nothing at all ───────────────────────────────────────────────────
# A fresh TUI with no flag, no tab, no prompt: there is provably no session to
# name, so the honest answer is to leave the client's line alone. (Measured on
# v2.0.32: the client prints no Continue line in this state either — the bridge
# must not manufacture one.)
H4="$WORK/home-empty"
W4="$WORK/ws-empty"
mkdir -p "$W4"
run_case empty "$H4" "$W4" "FAKE_ACP_MODELS=1 FAKE_ACP_CAPS_RESUME=1" "" "-" ""

echo
echo "── $PASSED passed, $FAILED failed, $NOTED notes (panes in .artifacts/epilogue)"
[ "$FAILED" = 0 ]
