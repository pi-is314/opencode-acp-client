#!/usr/bin/env bash
#
# Protocol verification against a **real** ACP agent — the check that "any ACP
# agent" is a fact rather than a slogan. Opt-in, because it needs an agent
# installed, and it takes the command rather than picking one for you: this project
# is not tied to any particular agent (the README lists the ones it has driven).
#
#   bash scripts/e2e-real-agent.sh
#   AGENT="<agent command>" bash scripts/e2e-real-agent.sh
#
# By default it does **not** send a prompt: initialize, `session/new` and the
# config options the agent advertises are all the client's own obligations, and
# they can be checked without spending a model turn. Set `PROMPT=1` to send one
# trivial prompt as well — that does spend tokens.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

AGENT="${AGENT:-}"
if [ -z "$AGENT" ]; then
  echo "✗ name the ACP agent to verify, for example:" >&2
  echo "    AGENT='<agent command>' bash scripts/e2e-real-agent.sh" >&2
  echo "  (the README lists agents this project has actually been driven against)" >&2
  exit 1
fi
# (no --port: the launch path picks a free one and reports it in the ready line)
OUT="$(mktemp)"
MAP_DIR="$(mktemp -d)"
export OPENCODE_ACP_CLIENT_SESSION_MAP="$MAP_DIR/sessions.json"
TUI="$HERE/tests/fake-opencode-tui.mjs"
BRIDGE_PID=""
FAILED=0

fail() { echo "  ✗ $1" >&2; FAILED=1; }
ok() { echo "  ✓ $1"; }

cleanup() {
  [ -n "$BRIDGE_PID" ] && kill -TERM "$BRIDGE_PID" 2>/dev/null || true
  [ -n "$BRIDGE_PID" ] && wait "$BRIDGE_PID" 2>/dev/null || true
  rm -f "$OUT"
  rm -rf "$MAP_DIR"
}
trap cleanup EXIT

echo "▸ agent: $AGENT"
# The *launch* path, with a TUI that stays up: it is what makes the bridge run
# `session/new` at startup, and the agent's real config options only exist after
# that. With `--no-tui` nothing is spawned, `/api/model` answers its
# placeholder, and the check below would pass without proving anything.
FAKE_TUI_SLEEP_MS=40000 OPENCODE_BIN="$TUI" node dist/index.js "$HERE" -- $AGENT >"$OUT" 2>&1 &
BRIDGE_PID=$!
for _ in $(seq 1 80); do
  grep -q '"type":"ready"' "$OUT" 2>/dev/null && break
  sleep 0.25
done
grep -q '"type":"ready"' "$OUT" || { fail "no ready line"; cat "$OUT"; exit 1; }
# The port is whatever the ready line says (the launch path defaults to a random
# one); reading it here is also the check that the line is usable.
URL="$(sed -n 's/.*"type":"ready","url":"\([^"]*\)".*/\1/p' "$OUT" | head -1)"
[ -n "$URL" ] || { fail "the ready line carried no url"; cat "$OUT"; exit 1; }
ok "server up: $URL"

get() { curl -s -m 20 "$URL$1"; }

# The composer silently refuses to submit while /api/agent is empty, so this is a
# functional requirement, not a nicety.
AGENTS="$(get /api/agent | python3 -c 'import sys,json;print(len(json.load(sys.stdin).get("data") or []))')"
[ "$AGENTS" != "0" ] && ok "/api/agent advertises $AGENTS agent(s)" || fail "/api/agent is empty (the composer would refuse to submit)"

# `/api/model` answers a single placeholder (`acp/default`) until a session has
# reached ACP, so "anything but that one row" is the evidence that `initialize` +
# `session/new` succeeded against this agent and that its config options were
# translated. It is also the list the TUI's model picker shows.
#
# ★ The test identifies the placeholder by its ID, not by the provider: an agent that
# advertises no provider grouping (codex-acp) has all of its models under the same
# `acp` provider, so "providerID != acp" counted 32 real models as zero and reported
# "never left the placeholder" against an agent that had answered perfectly.
REAL_MODELS=0
for _ in $(seq 1 80); do
  REAL_MODELS="$(get /api/model | python3 -c '
import sys, json
models = json.load(sys.stdin).get("data") or []
print(len([m for m in models if not (m.get("providerID") == "acp" and m.get("id") == "default")]))')"
  [ "${REAL_MODELS:-0}" != "0" ] && break
  sleep 0.25
done
if [ "${REAL_MODELS:-0}" != "0" ]; then
  ok "/api/model carries $REAL_MODELS model(s) from the agent's own config options"
  get /api/model | python3 -c '
import sys, json
for model in (json.load(sys.stdin).get("data") or [])[:4]:
    print("    - %s/%s (%s)" % (model.get("providerID"), model.get("modelID"), model.get("name")))'
else
  fail "/api/model never left the placeholder: the agent advertised no models, or session/new failed"
  tail -5 "$OUT"
fi

SESSION="$(curl -s -m 20 -X POST "$URL/api/session" -H 'content-type: application/json' -d '{}' \
  | python3 -c 'import sys,json;print((json.load(sys.stdin).get("data") or {}).get("id",""))')"
[ -n "$SESSION" ] && ok "session created: $SESSION" || fail "session creation failed"

INFO="$(get "/api/session/$SESSION")"
TITLE="$(printf '%s' "$INFO" | python3 -c 'import sys,json;print((json.load(sys.stdin).get("data") or {}).get("title",""))')"
ok "session title: ${TITLE:-<none>}"

for route in "/api/session/$SESSION/form" /api/form/request /api/permission/request; do
  BODY="$(get "$route")"
  case "$BODY" in
    *'"data"'*) ok "GET $route answers a well-formed envelope" ;;
    *) fail "GET $route did not answer a data envelope: $(printf '%s' "$BODY" | head -c 120)" ;;
  esac
done

if [ "${PROMPT:-0}" = "1" ]; then
  echo "▸ sending one prompt (this spends model tokens)"
  curl -s -m 180 -X POST "$URL/api/session/$SESSION/prompt" \
    -H 'content-type: application/json' -d '{"text":"Reply with exactly: pong"}' >/dev/null
  # Read the transcript the way the TUI does: `/message` lists message *infos*
  # only, so each message's parts come from `/message/:id`. Reading parts off the
  # list is how a probe concludes "no text arrived" while the text is right there.
  python3 - "$URL" "$SESSION" <<'PY' || exit 1
import json, sys, time, urllib.request

url, session = sys.argv[1], sys.argv[2]

def get(path):
    with urllib.request.urlopen(url + path, timeout=15) as response:
        return json.load(response)

deadline = time.time() + 150
text = ''
while time.time() < deadline:
    for message in get('/api/session/%s/message' % session).get('data') or []:
        if message.get('role') != 'assistant':
            continue
        detail = get('/api/session/%s/message/%s' % (session, message['id'])).get('data') or {}
        for part in detail.get('parts') or []:
            if part.get('type') == 'text' and part.get('text'):
                text += part['text']
    if text:
        break
    time.sleep(3)

if not text:
    print('  ✗ no assistant text arrived within 150s')
    raise SystemExit(1)
print('  ✓ assistant text: %r' % text[:200])
PY
fi

echo
if [ "$FAILED" = "0" ]; then
  echo "✓ the real agent drives the client's whole surface"
else
  echo "✗ real-agent verification failed" >&2
  exit 1
fi
