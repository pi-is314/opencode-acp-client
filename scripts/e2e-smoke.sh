#!/usr/bin/env bash
#
#
# Contract/trigger: the real HTTP + SSE surface the opencode v2 client reads,
#   driven without a TUI. Run for any route, event or projection change.
# Boundary: bridge process -> fake agent over stdio. No client binary, no model.
# Oracles: the HTTP responses and the SSE frames, in order — the same bytes the
#   TUI consumes.
# Negative controls: an unknown route must answer the empty envelope, not 404;
#   a failed agent start must surface as an error turn, not a silent drop.
## End-to-end smoke against a *fake* ACP agent and the *real* HTTP surface.
#
# It drives the built server exactly the way the opencode v2 client does —
# subscribe to /api/event, create a session, prompt, assert the stream — which
# is the layer the unit suite cannot reach.
#
# Usage:  bash scripts/e2e-smoke.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

# ★ Pick a FREE port. Fixed 4589 broke the same way 4811 broke the real-TUI script: a bridge
# left listening by an interrupted run makes the next one die with EADDRINUSE, which surfaces
# as "bridge never printed its ready line" — a message that says nothing about the cause.
if [ -z "${PORT:-}" ]; then
  for _try in $(seq 1 50); do
    PORT=$((4400 + RANDOM % 400))
    lsof -i ":$PORT" >/dev/null 2>&1 || break
  done
fi
PORT="${PORT:-4589}"
AGENT="$HERE/tests/fake-acp-agent.mjs"
OUT="$(mktemp)"
ERR="$(mktemp)"
SSE="$(mktemp)"
MAP_DIR="$(mktemp -d)"
export OPENCODE_ACP_CLIENT_SESSION_MAP="$MAP_DIR/sessions.json"
BRIDGE_PID=""

cleanup() {
  [ -n "$BRIDGE_PID" ] && kill "$BRIDGE_PID" 2>/dev/null || true
  rm -f "$OUT" "$ERR" "$SSE"
  rm -rf "$MAP_DIR"
}
trap cleanup EXIT

fail() { echo "  ✗ $1" >&2; echo "--- bridge stderr ---" >&2; tail -20 "$ERR" >&2; exit 1; }

echo "▸ building"
[ -f dist/index.js ] || ./node_modules/.bin/tsc -p tsconfig.json

echo "▸ starting bridge on :$PORT (fake agent)"
# --no-tui: starting the opencode TUI is the default; the harness wants only
# the HTTP/SSE surface.
node dist/index.js --no-tui --bridge-port "$PORT" --directory /tmp -- node "$AGENT" >"$OUT" 2>"$ERR" &
BRIDGE_PID=$!

for _ in $(seq 1 40); do
  grep -q '"type":"ready"' "$OUT" 2>/dev/null && break
  sleep 0.25
done
grep -q '"type":"ready"' "$OUT" || fail "bridge never printed its ready line"
echo "  ✓ ready: $(head -1 "$OUT")"

# Subscribe *before* acting: the hub only replays a bounded ring.
curl -sN --max-time 20 "http://127.0.0.1:$PORT/api/event" >"$SSE" 2>/dev/null &
SSE_PID=$!
sleep 1

echo "▸ creating a session"
SESSION=$(curl -s -X POST "http://127.0.0.1:$PORT/api/session" \
  -H 'content-type: application/json' -d '{}' \
  | python3 -c 'import sys,json;print((json.load(sys.stdin).get("data") or {}).get("id",""))')
[ -n "$SESSION" ] || fail "no session id returned"
echo "  ✓ session $SESSION"

echo "▸ prompting"
curl -s -X POST "http://127.0.0.1:$PORT/api/session/$SESSION/prompt" \
  -H 'content-type: application/json' \
  -d '{"parts":[{"type":"text","text":"ping"}]}' >/dev/null

sleep 4
kill "$SSE_PID" 2>/dev/null || true

echo "▸ asserting the event stream"
python3 - "$SSE" <<'PY' || exit 1
import io, json, sys
types = []
for line in io.open(sys.argv[1], encoding='utf-8', errors='replace'):
    line = line.strip()
    if line.startswith('data: '):
        try:
            types.append(json.loads(line[6:]).get('type'))
        except Exception:
            pass
required = [
    'server.connected',
    'session.created',
    'message.updated',
    'turn.wait',
    # The client admits the user row optimistically and reconciles from these.
    'session.inbox.enqueued',
    'session.inbox.delivered',
]
missing = [t for t in required if t not in types]
if missing:
    print('  ✗ missing events:', missing)
    print('  saw:', types)
    raise SystemExit(1)
if 'message.part.updated' not in types:
    print('  ✗ no part update (the agent reply never surfaced)')
    print('  saw:', types)
    raise SystemExit(1)
print('  ✓ events:', ' → '.join(t for t in types if t))
PY

# ---------------------------------------------------------------------------
# Scenario 2: a permission round-trip.
#
# The TUI builds its approval dialog from `permission.asked` (v2 shape) and
# answers on POST /api/session/:id/permission/:requestID/reply with
# {reply:"once"|"always"|"reject"}. A wrong field name here is invisible: the
# dialog simply never appears and the turn hangs forever.
# ---------------------------------------------------------------------------
echo
echo "▸ scenario 2: permission round-trip"

kill "$BRIDGE_PID" 2>/dev/null || true
wait "$BRIDGE_PID" 2>/dev/null || true
: >"$OUT"; : >"$ERR"; : >"$SSE"

FAKE_ACP_PERMISSION=allow node dist/index.js --no-tui --bridge-port "$PORT" --directory /tmp -- node "$AGENT" >"$OUT" 2>"$ERR" &
BRIDGE_PID=$!
for _ in $(seq 1 40); do
  grep -q '"type":"ready"' "$OUT" 2>/dev/null && break
  sleep 0.25
done
grep -q '"type":"ready"' "$OUT" || fail "bridge never printed its ready line (permission scenario)"

curl -sN --max-time 20 "http://127.0.0.1:$PORT/api/event" >"$SSE" 2>/dev/null &
SSE_PID=$!
sleep 1

P_SESSION=$(curl -s -X POST "http://127.0.0.1:$PORT/api/session" \
  -H 'content-type: application/json' -d '{}' \
  | python3 -c 'import sys,json;print((json.load(sys.stdin).get("data") or {}).get("id",""))')
[ -n "$P_SESSION" ] || fail "no session id returned (permission scenario)"
echo "  ✓ session $P_SESSION"

curl -s -X POST "http://127.0.0.1:$PORT/api/session/$P_SESSION/prompt" \
  -H 'content-type: application/json' \
  -d '{"parts":[{"type":"text","text":"permission please"}]}' >/dev/null

# Wait for the ask to arrive on the stream.
PERM_ID=""
for _ in $(seq 1 40); do
  PERM_ID=$(python3 - "$SSE" <<'PY'
import io, json, sys
try:
    lines = io.open(sys.argv[1], encoding='utf-8', errors='replace').read().splitlines()
except OSError:
    lines = []
for line in lines:
    if not line.startswith('data: '):
        continue
    try:
        event = json.loads(line[6:])
    except Exception:
        continue
    if event.get('type') == 'permission.asked':
        data = event.get('data') or {}
        # v2 shape: action must be present, and the v1 `tool` field must not be.
        if not data.get('action'):
            print('__WRONG_SHAPE__')
        elif 'tool' in data:
            print('__V1_SHAPE__')
        else:
            print(data.get('id', ''))
        break
PY
)
  [ -n "$PERM_ID" ] && break
  sleep 0.25
done

case "$PERM_ID" in
  "") fail "no permission.asked event observed" ;;
  __WRONG_SHAPE__) fail "permission.asked is missing the v2 'action' field" ;;
  __V1_SHAPE__) fail "permission.asked still carries the v1 'tool' field" ;;
esac
echo "  ✓ permission.asked id=$PERM_ID (v2 shape)"

echo "▸ replying {reply:once}"
curl -s -o /dev/null -w '%{http_code}' -X POST \
  "http://127.0.0.1:$PORT/api/session/$P_SESSION/permission/$PERM_ID/reply" \
  -H 'content-type: application/json' -d '{"reply":"once"}' >"$OUT.reply" || true
REPLY_STATUS="$(cat "$OUT.reply")"
[ "$REPLY_STATUS" = "204" ] || fail "permission reply returned $REPLY_STATUS, expected 204"

sleep 4
kill "$SSE_PID" 2>/dev/null || true

python3 - "$SSE" <<'PY' || exit 1
import io, json, sys
types = []
for line in io.open(sys.argv[1], encoding='utf-8', errors='replace'):
    line = line.strip()
    if line.startswith('data: '):
        try:
            types.append(json.loads(line[6:]).get('type'))
        except Exception:
            pass
for required in ('permission.asked', 'permission.replied'):
    if required not in types:
        print('  ✗ missing event:', required)
        print('  saw:', types)
        raise SystemExit(1)
print('  ✓ permission events:', ' → '.join(t for t in types if t and 'permission' in t or t == 'session.status'))
PY

# The agent echoes the outcome it received. That is the half a fixture bug used to
# hide: the bridge emitted permission.replied, but the answer never arrived.
python3 - "$SSE" <<'PY' || exit 1
import io, json, sys
text = ''
for line in io.open(sys.argv[1], encoding='utf-8', errors='replace'):
    line = line.strip()
    if not line.startswith('data: '):
        continue
    try:
        event = json.loads(line[6:])
    except Exception:
        continue
    if event.get('type') == 'session.text.delta':
        text += (event.get('data') or {}).get('delta') or ''
marker = text.find('PERM ')
if marker < 0:
    print('  ✗ the agent never reported a permission outcome; text:', text[:200])
    raise SystemExit(1)
outcome, _ = json.JSONDecoder().raw_decode(text[marker + len('PERM '):])
if outcome.get('outcome') != 'selected' or not outcome.get('optionId'):
    print('  ✗ the agent received the wrong outcome:', outcome)
    raise SystemExit(1)
print('  ✓ the agent received the outcome:', json.dumps(outcome))
PY

echo
echo "▸ scenario 3: shell (\`!\`) round-trip"

: >"$SSE"
curl -sN --max-time 20 "http://127.0.0.1:$PORT/api/event" >"$SSE" 2>/dev/null &
SSE_PID=$!
sleep 1

SHELL_RESP=$(curl -s -X POST "http://127.0.0.1:$PORT/api/shell" \
  -H 'content-type: application/json' \
  -d '{"command":{"command":"echo shell-hello; echo shell-err >&2","timeout":10000}}')
SHELL_ID=$(printf '%s' "$SHELL_RESP" | python3 -c \
  'import sys,json;print((json.load(sys.stdin).get("data") or {}).get("id",""))')
[ -n "$SHELL_ID" ] || fail "no shell id returned: $SHELL_RESP"
echo "  ✓ shell $SHELL_ID"

sleep 2
OUT=$(curl -s "http://127.0.0.1:$PORT/api/shell/$SHELL_ID/output?cursor=0" \
  | python3 -c 'import sys,json;print((json.load(sys.stdin).get("data") or {}).get("output",""))')
case "$OUT" in
  *shell-hello*) ;;
  *) fail "shell output missing stdout: $(printf '%q' "$OUT")" ;;
esac
case "$OUT" in
  *shell-err*) ;;
  *) fail "shell output missing stderr: $(printf '%q' "$OUT")" ;;
esac
echo "  ✓ output captured (stdout + stderr)"

STATUS=$(curl -s "http://127.0.0.1:$PORT/api/shell/$SHELL_ID" \
  | python3 -c 'import sys,json;print((json.load(sys.stdin).get("data") or {}).get("status",""))')
[ "$STATUS" = "exited" ] || fail "shell status is '$STATUS', expected exited"
echo "  ✓ status exited"

kill "$SSE_PID" 2>/dev/null || true
python3 - "$SSE" <<'PY' || exit 1
import io, json, sys
types = []
for line in io.open(sys.argv[1], encoding='utf-8', errors='replace'):
    line = line.strip()
    if line.startswith('data: '):
        try:
            types.append(json.loads(line[6:]).get('type'))
        except Exception:
            pass
for required in ('session.shell.started', 'session.shell.ended'):
    if required not in types:
        print('  ✗ missing event:', required)
        print('  saw:', types)
        raise SystemExit(1)
print('  ✓ shell events:', ' → '.join(t for t in types if t and t.startswith('session.shell')))
PY

echo
echo "▸ scenario 4: the agent moves its own configuration (config_option_update + session_info_update)"

kill "$BRIDGE_PID" 2>/dev/null || true
wait "$BRIDGE_PID" 2>/dev/null || true
: >"$OUT"; : >"$ERR"; : >"$SSE"

# `session.model.selected` and `session.renamed` are the events the TUI's store
# actually reads for these two changes; `session.updated` is in neither path.
FAKE_ACP_MODELS=1 FAKE_ACP_MODEL_UPDATE='["fake","model-2"]' FAKE_ACP_TITLE='Renamed by the agent' \
  node dist/index.js --no-tui --bridge-port "$PORT" --directory /tmp -- node "$AGENT" >"$OUT" 2>"$ERR" &
BRIDGE_PID=$!
for _ in $(seq 1 40); do
  grep -q '"type":"ready"' "$OUT" 2>/dev/null && break
  sleep 0.25
done
grep -q '"type":"ready"' "$OUT" || fail "bridge never printed its ready line (agent-config scenario)"

curl -sN --max-time 20 "http://127.0.0.1:$PORT/api/event" >"$SSE" 2>/dev/null &
SSE_PID=$!
sleep 1

A_SESSION=$(curl -s -X POST "http://127.0.0.1:$PORT/api/session" \
  -H 'content-type: application/json' -d '{}' \
  | python3 -c 'import sys,json;print((json.load(sys.stdin).get("data") or {}).get("id",""))')
[ -n "$A_SESSION" ] || fail "no session id returned (agent-config scenario)"
echo "  ✓ session $A_SESSION"

curl -s -X POST "http://127.0.0.1:$PORT/api/session/$A_SESSION/prompt" \
  -H 'content-type: application/json' -d '{"text":"move yourself"}' >/dev/null
sleep 2

kill "$SSE_PID" 2>/dev/null || true
python3 - "$SSE" <<'PY' || exit 1
import io, json, sys
events = []
for line in io.open(sys.argv[1], encoding='utf-8', errors='replace'):
    line = line.strip()
    if line.startswith('data: '):
        try:
            events.append(json.loads(line[6:]))
        except Exception:
            pass
by_type = {}
for event in events:
    by_type.setdefault(event.get('type'), []).append(event.get('data') or {})

if not events:
    print('  ✗ no events at all')
    raise SystemExit(1)

model = by_type.get('session.model.selected')
if not model:
    print('  ✗ missing session.model.selected; saw:', [e.get('type') for e in events])
    raise SystemExit(1)
picked = model[-1].get('model') or {}
if picked.get('providerID') != 'fake' or picked.get('modelID') != 'model-2':
    print('  ✗ model.selected carried the wrong model:', picked)
    raise SystemExit(1)
print('  ✓ session.model.selected → %s/%s' % (picked.get('providerID'), picked.get('modelID')))

renamed = by_type.get('session.renamed')
if not renamed:
    print('  ✗ missing session.renamed; saw:', [e.get('type') for e in events])
    raise SystemExit(1)
if renamed[-1].get('title') != 'Renamed by the agent':
    print('  ✗ session.renamed carried the wrong title:', renamed[-1].get('title'))
    raise SystemExit(1)
print('  ✓ session.renamed → %r' % renamed[-1].get('title'))
PY

echo
echo "▸ scenario 5: elicitation/create → the TUI's form surface → back to the agent"

kill "$BRIDGE_PID" 2>/dev/null || true
wait "$BRIDGE_PID" 2>/dev/null || true
: >"$OUT"; : >"$ERR"; : >"$SSE"

FAKE_ACP_ELICIT=1 node dist/index.js --no-tui --bridge-port "$PORT" --directory /tmp -- node "$AGENT" >"$OUT" 2>"$ERR" &
BRIDGE_PID=$!
for _ in $(seq 1 40); do
  grep -q '"type":"ready"' "$OUT" 2>/dev/null && break
  sleep 0.25
done
grep -q '"type":"ready"' "$OUT" || fail "bridge never printed its ready line (elicitation scenario)"

curl -sN --max-time 25 "http://127.0.0.1:$PORT/api/event" >"$SSE" 2>/dev/null &
SSE_PID=$!
sleep 1

E_SESSION=$(curl -s -X POST "http://127.0.0.1:$PORT/api/session" \
  -H 'content-type: application/json' -d '{}' \
  | python3 -c 'import sys,json;print((json.load(sys.stdin).get("data") or {}).get("id",""))')
[ -n "$E_SESSION" ] || fail "no session id returned (elicitation scenario)"
echo "  ✓ session $E_SESSION"

# The prompt blocks on the elicitation, so this returns immediately and the form
# arrives out of band — exactly as a real agent drives it.
curl -s -X POST "http://127.0.0.1:$PORT/api/session/$E_SESSION/prompt" \
  -H 'content-type: application/json' -d '{"text":"ask me"}' >/dev/null

FORM_ID=""
for _ in $(seq 1 40); do
  FORM_ID=$(curl -s "http://127.0.0.1:$PORT/api/session/$E_SESSION/form" \
    | python3 -c 'import sys,json;d=json.load(sys.stdin).get("data") or [];print(d[0]["id"] if d else "")' 2>/dev/null)
  [ -n "$FORM_ID" ] && break
  sleep 0.25
done
[ -n "$FORM_ID" ] || fail "no pending form appeared for the session"
case "$FORM_ID" in
  frm_*) ;;
  *) fail "form id '$FORM_ID' does not carry the frm_ prefix the TUI requires" ;;
esac
echo "  ✓ pending form $FORM_ID"

# The form the TUI would render, checked field by field.
curl -s "http://127.0.0.1:$PORT/api/session/$E_SESSION/form/$FORM_ID" \
  | python3 -c '
import sys, json
info = json.load(sys.stdin).get("data") or {}
fields = {f["key"]: f for f in info.get("fields", [])}
assert info.get("title") == "Which strategy should I use?", info.get("title")
assert fields["strategy"]["type"] == "string" and fields["strategy"]["required"] is True, fields.get("strategy")
assert [o["value"] for o in fields["strategy"]["options"]] == ["conservative", "balanced"], fields.get("strategy")
assert fields["notes"]["type"] == "string", fields.get("notes")
assert fields["extras"]["type"] == "multiselect", fields.get("extras")
' || fail "the published form does not match the agent's schema"
echo "  ✓ form fields match the requested schema"

curl -s -X POST "http://127.0.0.1:$PORT/api/session/$E_SESSION/form/$FORM_ID/reply" \
  -H 'content-type: application/json' \
  -d '{"answer":{"strategy":"balanced","notes":"from the smoke","extras":["fast"]}}' >/dev/null
echo "  ✓ replied"

sleep 2
kill "$SSE_PID" 2>/dev/null || true
python3 - "$SSE" <<'PY' || exit 1
import io, json, sys
events = []
for line in io.open(sys.argv[1], encoding='utf-8', errors='replace'):
    line = line.strip()
    if line.startswith('data: '):
        try:
            events.append(json.loads(line[6:]))
        except Exception:
            pass
types = [e.get('type') for e in events]
if 'form.created' not in types:
    print('  ✗ missing form.created; saw:', types)
    raise SystemExit(1)
if 'form.replied' not in types:
    print('  ✗ missing form.replied; saw:', types)
    raise SystemExit(1)
# The agent echoes the answer it received; every field the user filled must be
# there, which is what proves the round trip (not just that a form appeared).
text = ''.join(
    (e.get('data') or {}).get('delta') or ''
    for e in events
    if e.get('type') in ('session.text.delta',)
)
if 'ELICIT ' not in text:
    print('  ✗ the agent never echoed an elicitation answer; text:', text[:300])
    raise SystemExit(1)
# `raw_decode`, not `split`: the answer chunk is followed by the agent's ordinary
# reply text in the same stream.
echoed, _ = json.JSONDecoder().raw_decode(text[text.find('ELICIT ') + len('ELICIT '):])
if echoed.get('action') != 'accept':
    print('  ✗ answer action is not accept:', echoed)
    raise SystemExit(1)
content = echoed.get('content') or {}
if content.get('strategy') != 'balanced' or content.get('notes') != 'from the smoke' or content.get('extras') != ['fast']:
    print('  ✗ answer content did not round-trip:', content)
    raise SystemExit(1)
print('  ✓ form.created → reply → agent received', json.dumps(content))
PY

echo
echo "▸ scenario 6: a mode we never advertised is refused, not half-served (url elicitation)"

kill "$BRIDGE_PID" 2>/dev/null || true
wait "$BRIDGE_PID" 2>/dev/null || true
: >"$OUT"; : >"$ERR"; : >"$SSE"

FAKE_ACP_ELICIT=url node dist/index.js --no-tui --bridge-port "$PORT" --directory /tmp -- node "$AGENT" >"$OUT" 2>"$ERR" &
BRIDGE_PID=$!
for _ in $(seq 1 40); do
  grep -q '"type":"ready"' "$OUT" 2>/dev/null && break
  sleep 0.25
done
grep -q '"type":"ready"' "$OUT" || fail "bridge never printed its ready line (url-elicitation scenario)"

curl -sN --max-time 20 "http://127.0.0.1:$PORT/api/event" >"$SSE" 2>/dev/null &
SSE_PID=$!
sleep 1

U_SESSION=$(curl -s -X POST "http://127.0.0.1:$PORT/api/session" \
  -H 'content-type: application/json' -d '{}' \
  | python3 -c 'import sys,json;print((json.load(sys.stdin).get("data") or {}).get("id",""))')
[ -n "$U_SESSION" ] || fail "no session id returned (url-elicitation scenario)"

curl -s -X POST "http://127.0.0.1:$PORT/api/session/$U_SESSION/prompt" \
  -H 'content-type: application/json' -d '{"text":"authorize"}' >/dev/null
sleep 2

# Nothing may have been published to the form queue for a url request.
PENDING=$(curl -s "http://127.0.0.1:$PORT/api/session/$U_SESSION/form" \
  | python3 -c 'import sys,json;print(len(json.load(sys.stdin).get("data") or []))')
[ "$PENDING" = "0" ] || fail "a url elicitation produced $PENDING form(s); the mode gate is not in force"

kill "$SSE_PID" 2>/dev/null || true
python3 - "$SSE" <<'PY' || exit 1
import io, json, sys
text = ''
for line in io.open(sys.argv[1], encoding='utf-8', errors='replace'):
    line = line.strip()
    if not line.startswith('data: '):
        continue
    try:
        event = json.loads(line[6:])
    except Exception:
        continue
    if event.get('type') == 'session.text.delta':
        text += (event.get('data') or {}).get('delta') or ''
marker = text.find('ELICIT ')
if marker < 0:
    print('  ✗ the agent never reported the elicitation result; text:', text[:200])
    raise SystemExit(1)
result, _ = json.JSONDecoder().raw_decode(text[marker + len('ELICIT '):])
code = (result.get('error') or {}).get('code')
if code != -32602:
    print('  ✗ expected -32602 for the unadvertised url mode, got:', result)
    raise SystemExit(1)
print('  ✓ url mode refused with -32602, no form published')
PY

echo
echo "▸ scenario 7: abort answers a pending permission with cancelled (ACP §Cancellation)"

kill "$BRIDGE_PID" 2>/dev/null || true
wait "$BRIDGE_PID" 2>/dev/null || true
: >"$OUT"; : >"$ERR"; : >"$SSE"

FAKE_ACP_PERMISSION=allow node dist/index.js --no-tui --bridge-port "$PORT" --directory /tmp -- node "$AGENT" >"$OUT" 2>"$ERR" &
BRIDGE_PID=$!
for _ in $(seq 1 40); do
  grep -q '"type":"ready"' "$OUT" 2>/dev/null && break
  sleep 0.25
done
grep -q '"type":"ready"' "$OUT" || fail "bridge never printed its ready line (abort scenario)"

curl -sN --max-time 20 "http://127.0.0.1:$PORT/api/event" >"$SSE" 2>/dev/null &
SSE_PID=$!
sleep 1

B_SESSION=$(curl -s -X POST "http://127.0.0.1:$PORT/api/session" \
  -H 'content-type: application/json' -d '{}' \
  | python3 -c 'import sys,json;print((json.load(sys.stdin).get("data") or {}).get("id",""))')
[ -n "$B_SESSION" ] || fail "no session id returned (abort scenario)"

curl -s -X POST "http://127.0.0.1:$PORT/api/session/$B_SESSION/prompt" \
  -H 'content-type: application/json' -d '{"text":"do something risky"}' >/dev/null

# Wait until the agent is actually blocked on the approval dialog.
ASKED=""
for _ in $(seq 1 40); do
  ASKED=$(curl -s "http://127.0.0.1:$PORT/api/session/$B_SESSION/permission" \
    | python3 -c 'import sys,json;d=json.load(sys.stdin).get("data") or [];print(d[0]["id"] if d else "")' 2>/dev/null)
  [ -n "$ASKED" ] && break
  sleep 0.25
done
[ -n "$ASKED" ] || fail "no permission request became pending"
echo "  ✓ permission pending: $ASKED"

curl -s -X POST "http://127.0.0.1:$PORT/api/session/$B_SESSION/abort" >/dev/null
echo "  ✓ aborted"

sleep 2
kill "$SSE_PID" 2>/dev/null || true
python3 - "$SSE" <<'PY' || exit 1
import io, json, sys
events = []
for line in io.open(sys.argv[1], encoding='utf-8', errors='replace'):
    line = line.strip()
    if line.startswith('data: '):
        try:
            events.append(json.loads(line[6:]))
        except Exception:
            pass
types = [e.get('type') for e in events]
if 'permission.replied' not in types:
    print('  ✗ abort did not answer the pending permission; saw:', types)
    raise SystemExit(1)
if 'session.execution.interrupted' not in types:
    print('  ✗ a cancelled turn must end as session.execution.interrupted; saw:', types)
    raise SystemExit(1)
if 'session.execution.succeeded' in types:
    print('  ✗ a cancelled turn reported succeeded (the UI would show it as finished on its own); saw:', types)
    raise SystemExit(1)
text = ''.join((e.get('data') or {}).get('delta') or '' for e in events if e.get('type') == 'session.text.delta')
marker = text.find('PERM ')
if marker < 0:
    print('  ✗ the agent never reported the outcome it received; text:', text[:200])
    raise SystemExit(1)
outcome, _ = json.JSONDecoder().raw_decode(text[marker + len('PERM '):])
if outcome.get('outcome') != 'cancelled':
    print('  ✗ expected the cancelled outcome, got:', outcome)
    raise SystemExit(1)
print('  ✓ agent received the cancelled outcome, no dangling dialog')
PY

# ===========================================================================
# Scenario engine (`FAKE_ACP_SCENARIO`).
#
# One coherent agent behaviour per case, so the assertion is about what the
# *client* did with it — the terminal states it chose, the events it emitted,
# the log lines it wrote — not about the agent echoing what it was told.
#
# Scenario numbers are stable labels in this file, not a contract: each new
# behaviour appends the next number (`docs/SCENARIOS.md` carries the table).
# ===========================================================================

echo
echo "▸ scenario 8: hostile — an agent that breaks the rules is logged, not crashed on"

# Start the bridge with `KEY=VALUE…` overrides and wait for its ready line.
start_bridge() {
  kill "$BRIDGE_PID" 2>/dev/null || true
  wait "$BRIDGE_PID" 2>/dev/null || true
  : >"$OUT"; : >"$ERR"; : >"$SSE"
  env "$@" node dist/index.js --no-tui --bridge-port "$PORT" --directory /tmp -- node "$AGENT" >"$OUT" 2>"$ERR" &
  BRIDGE_PID=$!
  for _ in $(seq 1 60); do
    grep -q '"type":"ready"' "$OUT" 2>/dev/null && return 0
    sleep 0.25
  done
  fail "bridge never printed its ready line ($*)"
}

new_session() {
  curl -s -X POST "http://127.0.0.1:$PORT/api/session" \
    -H 'content-type: application/json' -d '{}' \
    | python3 -c 'import sys,json;print((json.load(sys.stdin).get("data") or {}).get("id",""))'
}

subscribe() {
  kill "$SSE_PID" 2>/dev/null || true
  : >"$SSE"
  curl -sN --max-time "${1:-25}" "http://127.0.0.1:$PORT/api/event" >"$SSE" 2>/dev/null &
  SSE_PID=$!
  sleep 1
}

send_prompt() {  # $1 = session id, $2 = JSON body
  curl -s -X POST "http://127.0.0.1:$PORT/api/session/$1/prompt" \
    -H 'content-type: application/json' -d "$2" >/dev/null
}

# Wait for an event type to appear in the captured stream instead of guessing a
# duration; returns non-zero on timeout.
wait_for_event() {
  for _ in $(seq 1 80); do
    grep -q "\"type\":\"$1\"" "$SSE" 2>/dev/null && return 0
    sleep 0.25
  done
  return 1
}

# Run a python assertion program (on stdin) with the captured stream pre-parsed.
# The program gets `events`, `types`, `by_type()`, `text_deltas()`, `require()`,
# `ok()` and `fail()` for free, so each scenario states only its own claim.
check() {  # $1 = label
  local label="$1" program
  program="$(mktemp)"
  cat > "$program"
  if ! python3 - "$SSE" "$label" "$program" <<'PY'
import io, json, sys

sse, label, program = sys.argv[1], sys.argv[2], sys.argv[3]
events = []
for line in io.open(sse, encoding='utf-8', errors='replace'):
    line = line.strip()
    if line.startswith('data: '):
        try:
            events.append(json.loads(line[6:]))
        except Exception:
            pass
types = [e.get('type') for e in events]

def fail(message):
    print('  ✗ %s: %s' % (label, message))
    raise SystemExit(1)

def ok(message):
    print('  ✓ %s' % message)

def by_type(name):
    return [e.get('data') or {} for e in events if e.get('type') == name]

def text_deltas():
    return ''.join(
        (e.get('data') or {}).get('delta') or ''
        for e in events
        if e.get('type') == 'session.text.delta'
    )

def require(name):
    if name not in types:
        fail('missing event %s (saw: %s)' % (name, types))

exec(open(program, encoding='utf-8').read())
PY
  then
    rm -f "$program"
    fail "$label"
  fi
  rm -f "$program"
}

# A scenario is a starting point: a flag set alongside it still wins, which is
# what keeps every existing `FAKE_ACP_*` caller working.
start_bridge FAKE_ACP_SCENARIO=hostile FAKE_ACP_REPLY='hostile: survived'
subscribe 25
H_SESSION=$(new_session)
[ -n "$H_SESSION" ] || fail "no session id returned (hostile scenario)"
send_prompt "$H_SESSION" '{"parts":[{"type":"text","text":"misbehave"}]}'
wait_for_event turn.idle || fail "the hostile turn never settled (no turn.idle)"
sleep 1
kill "$SSE_PID" 2>/dev/null || true

check "hostile: the turn finished and the reply still arrived" <<'PY'
require('turn.idle')
require('session.execution.succeeded')
if 'session.step.failed' in types:
    fail('a hostile update turned the turn into a failure')
text = text_deltas()
if 'hostile: survived' not in text:
    fail('the reply after the hostile updates never arrived: %r' % text[:200])
ok('turn settled with the reply intact')
PY

# The client's contract for an update it cannot translate is to *say so*.
for needle in \
  'unknown session/update: notice' \
  'unknown session/update: compaction_update' \
  'unknown session/update: some_unknown_update_v9'; do
  grep -qF "$needle" "$ERR" || fail "the bridge never logged '$needle'"
done
echo "  ✓ logged every update it could not translate"

# Logged *and* alive: a crash would satisfy the log assertion on its own.
kill -0 "$BRIDGE_PID" 2>/dev/null || fail "the bridge process died on a hostile agent"
HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' -m 3 "http://127.0.0.1:$PORT/api/health")
[ "$HTTP_CODE" = "200" ] || fail "the bridge stopped serving after the hostile turn (health=$HTTP_CODE)"
echo "  ✓ still serving (GET /api/health → $HTTP_CODE)"

echo
echo "▸ scenario 9: error-turn — a failed stop reason is terminal, not a spinner"

start_bridge FAKE_ACP_SCENARIO=error-turn
subscribe 25
F_SESSION=$(new_session)
[ -n "$F_SESSION" ] || fail "no session id returned (error-turn scenario)"
send_prompt "$F_SESSION" '{"parts":[{"type":"text","text":"fail please"}]}'
wait_for_event turn.idle || fail "the failing turn never settled (no turn.idle)"
sleep 1
kill "$SSE_PID" 2>/dev/null || true

check "error-turn: the failure is terminal and nothing claims success" <<'PY'
require('session.execution.failed')
require('session.step.failed')
require('turn.idle')
if 'session.execution.succeeded' in types:
    fail('a failed turn was also reported as succeeded')
ok('session.execution.failed + session.step.failed + turn.idle')
PY

# The failure must survive into the transcript the TUI re-reads, not only the
# live stream.
python3 - "$PORT" "$F_SESSION" <<'PY' || exit 1
import json, sys, urllib.request
port, session = sys.argv[1], sys.argv[2]
with urllib.request.urlopen('http://127.0.0.1:%s/api/session/%s/message' % (port, session), timeout=5) as response:
    items = (json.load(response).get('data') or [])
assistants = [item for item in items if item.get('type') == 'assistant']
if not assistants:
    print('  ✗ no assistant message was recorded'); raise SystemExit(1)
assistant = assistants[-1]
if 'about to fail' not in json.dumps(assistant):
    print('  ✗ the partial reply was lost'); raise SystemExit(1)
message = (assistant.get('error') or {}).get('message') or ''
if 'agent stop reason: error' not in message:
    print('  ✗ the message carries no failure; error=%r' % message); raise SystemExit(1)
print('  ✓ transcript records the failure: %s' % message)
PY

# And the turn is gone from the status surface the TUI polls.
ACTIVE=$(curl -s "http://127.0.0.1:$PORT/api/session/active" \
  | python3 -c 'import sys,json;print(json.dumps(json.load(sys.stdin).get("data") or {}))')
case "$ACTIVE" in
  *"$F_SESSION"*) fail "a failed turn is still listed as active: $ACTIVE" ;;
esac
echo "  ✓ /api/session/active no longer lists it"

echo
echo "▸ scenario 10: tools-many — completed, failed, and one the agent abandons"

start_bridge FAKE_ACP_SCENARIO=tools-many
subscribe 25
T_SESSION=$(new_session)
[ -n "$T_SESSION" ] || fail "no session id returned (tools-many scenario)"
send_prompt "$T_SESSION" '{"parts":[{"type":"text","text":"three tools"}]}'
wait_for_event turn.idle || fail "the tools-many turn never settled (no turn.idle)"
sleep 1
kill "$SSE_PID" 2>/dev/null || true

check "tools-many: three rows, and the abandoned one is not left running" <<'PY'
require('session.tool.input.started')
if types.count('session.tool.input.started') != 3:
    fail('expected 3 tool rows, saw %d' % types.count('session.tool.input.started'))
require('session.tool.success')
require('session.tool.failed')
require('session.execution.succeeded')
require('turn.idle')
if 'boom' not in json.dumps(by_type('session.tool.failed')):
    fail('the failed tool carried no error content')
ok('3 rows; the failed one carries its error')
PY

# What the transcript says the tools ended as: the TUI re-reads this, so a client
# that merely stopped emitting events would still show a spinner after a reload.
python3 - "$PORT" "$T_SESSION" <<'PY' || exit 1
import json, sys, urllib.request
port, session = sys.argv[1], sys.argv[2]
with urllib.request.urlopen('http://127.0.0.1:%s/api/session/%s/message' % (port, session), timeout=5) as response:
    items = (json.load(response).get('data') or [])
tools = {}
for item in items:
    for entry in item.get('content') or []:
        if entry.get('type') == 'tool':
            tools[entry.get('name')] = entry.get('state') or {}
expected = {'echo-ok': 'completed', 'echo-fail': 'error'}
for name, status in expected.items():
    got = (tools.get(name) or {}).get('status')
    if got != status:
        print('  ✗ %s ended as %r, expected %r' % (name, got, status)); raise SystemExit(1)
abandoned = tools.get('echo-open') or {}
if abandoned.get('status') in (None, 'running'):
    print('  ✗ the abandoned tool is still running after the turn ended:', abandoned); raise SystemExit(1)
print('  ✓ transcript: echo-ok=completed, echo-fail=error, echo-open=%s' % abandoned.get('status'))
PY

echo
echo "▸ scenario 11: rich-turn — reasoning → tool (input + output) → reply, in order"

start_bridge FAKE_ACP_SCENARIO=rich-turn FAKE_ACP_REPLY='rich: final answer'
subscribe 25
R_SESSION=$(new_session)
[ -n "$R_SESSION" ] || fail "no session id returned (rich-turn scenario)"
send_prompt "$R_SESSION" '{"parts":[{"type":"text","text":"rich prompt"}]}'
wait_for_event turn.idle || fail "the rich turn never settled (no turn.idle)"
sleep 1
kill "$SSE_PID" 2>/dev/null || true

check "rich-turn: every layer surfaced, in the agent's order" <<'PY'
for name in (
    'session.reasoning.started',
    'session.reasoning.delta',
    'session.tool.input.started',
    'session.tool.called',
    'session.tool.success',
    'session.text.started',
    'session.step.ended',
    'session.execution.succeeded',
    'turn.idle',
):
    require(name)
layers = [name for name in types if name in (
    'session.reasoning.started', 'session.tool.input.started', 'session.text.started')]
if layers != ['session.reasoning.started', 'session.tool.input.started', 'session.text.started']:
    fail('the projection reordered the layers: %s' % layers)
input_text = (by_type('session.tool.input.ended')[-1] or {}).get('text') or ''
if '"text":"rich prompt"' not in input_text:
    fail('the tool input never reached the client: %r' % input_text)
if 'echo: rich prompt' not in json.dumps(by_type('session.tool.success')):
    fail('the tool output never reached the client')
if (by_type('session.step.ended')[-1] or {}).get('finish') != 'stop':
    fail('the step did not report finish=stop')
if 'rich: final answer' not in text_deltas():
    fail('the reply never arrived: %r' % text_deltas()[:200])
ok('reasoning → tool(input+output) → reply, in order')
PY

echo
echo "▸ scenario 12: plan — the client logs it; opencode v2 has no surface for it"

start_bridge FAKE_ACP_SCENARIO=plan FAKE_ACP_REPLY='plan: nothing rendered'
subscribe 25
P_SESSION=$(new_session)
[ -n "$P_SESSION" ] || fail "no session id returned (plan scenario)"
send_prompt "$P_SESSION" '{"parts":[{"type":"text","text":"make a plan"}]}'
wait_for_event turn.idle || fail "the plan turn never settled (no turn.idle)"
sleep 1
kill "$SSE_PID" 2>/dev/null || true

# Measured on opencode v2.0.28: a plan renders **nothing** at all (there is no
# todo surface left in v2). So the expectation is not "a todo appeared" but "the
# client emitted no plan/todo event and said so in its log".
grep -qF '[bridge] ACP plan update (2 entries) has no opencode v2 surface' "$ERR" \
  || fail "the plan update was not logged as having no opencode surface"

check "plan: no plan event, no extra part, reply intact" <<'PY'
require('turn.idle')
require('session.execution.succeeded')
offenders = [t for t in types if t and ('plan' in t.lower() or 'todo' in t.lower())]
if offenders:
    fail('a plan produced an event (%s); opencode v2 has no todo surface' % offenders)
tool_events = [t for t in types if t and t.startswith('session.tool.')]
if tool_events:
    fail('the plan turn produced tool events: %s' % tool_events)
if 'plan: nothing rendered' not in text_deltas():
    fail('the reply after the plan never arrived: %r' % text_deltas()[:200])
ok('no plan/todo event; reply intact')
PY

python3 - "$PORT" "$P_SESSION" <<'PY' || exit 1
import json, sys, urllib.request
port, session = sys.argv[1], sys.argv[2]
with urllib.request.urlopen('http://127.0.0.1:%s/api/session/%s/message' % (port, session), timeout=5) as response:
    items = (json.load(response).get('data') or [])
assistants = [item for item in items if item.get('type') == 'assistant']
if not assistants:
    print('  ✗ no assistant message was recorded'); raise SystemExit(1)
kinds = [entry.get('type') for entry in assistants[-1].get('content') or []]
if kinds != ['text']:
    print('  ✗ a plan changed the projected content: %s' % kinds); raise SystemExit(1)
print('  ✓ transcript has only the text part (%s)' % kinds)
PY

echo
echo "▸ scenario 13: permission — the approve and the reject path both round-trip"

# Drive one permission turn and assert what the *client* sent the agent. The
# expected option id and tool event differ per path, so they come in by env.
permission_path() {  # $1 = reply, $2 = expected optionId, $3 = expected tool event, $4 = label
  local session perm
  subscribe 25
  session=$(new_session)
  [ -n "$session" ] || fail "no session id returned ($4)"
  send_prompt "$session" '{"parts":[{"type":"text","text":"do something risky"}]}'
  perm=""
  for _ in $(seq 1 60); do
    perm=$(curl -s "http://127.0.0.1:$PORT/api/session/$session/permission" \
      | python3 -c 'import sys,json;d=json.load(sys.stdin).get("data") or [];print(d[0]["id"] if d else "")' 2>/dev/null)
    [ -n "$perm" ] && break
    sleep 0.25
  done
  [ -n "$perm" ] || fail "no permission request became pending ($4)"
  curl -s -o /dev/null -X POST \
    "http://127.0.0.1:$PORT/api/session/$session/permission/$perm/reply" \
    -H 'content-type: application/json' -d "{\"reply\":\"$1\"}"
  wait_for_event turn.idle || fail "the permission turn never settled ($4)"
  sleep 1
  kill "$SSE_PID" 2>/dev/null || true
  export SCEN_EXPECT_OPTION="$2" SCEN_EXPECT_TOOL="$3" SCEN_EXPECT_LABEL="$4"
  check "$4" <<'PY'
import os
require('permission.asked')
require('permission.replied')
require(os.environ['SCEN_EXPECT_TOOL'])
require('turn.idle')
# A refusal is a settled turn the client finished, not an error and not a hang.
require('session.execution.succeeded')
if 'session.execution.failed' in types or 'session.execution.interrupted' in types:
    fail('the turn reported the wrong outcome')
text = text_deltas()
marker = text.find('PERM ')
if marker < 0:
    fail('the agent never reported the permission outcome it received')
outcome, _ = json.JSONDecoder().raw_decode(text[marker + len('PERM '):])
expected = os.environ['SCEN_EXPECT_OPTION']
if outcome.get('optionId') != expected or outcome.get('outcome') != 'selected':
    fail('the agent received %r, expected a selected %r' % (outcome, expected))
ok('%s → client sent %s, the agent received it' % (os.environ['SCEN_EXPECT_LABEL'], expected))
PY
  unset SCEN_EXPECT_OPTION SCEN_EXPECT_TOOL SCEN_EXPECT_LABEL
}

start_bridge FAKE_ACP_SCENARIO=permission
permission_path once allow-once session.tool.success "permission/approve"
permission_path reject reject-once session.tool.failed "permission/reject"

echo
echo "▸ scenario 14: elicit-form — the cancel path dismisses the form and answers the agent"

start_bridge FAKE_ACP_SCENARIO=elicit-form
subscribe 25
EF_SESSION=$(new_session)
[ -n "$EF_SESSION" ] || fail "no session id returned (elicit-form scenario)"
send_prompt "$EF_SESSION" '{"parts":[{"type":"text","text":"ask me"}]}'
EF_FORM=""
for _ in $(seq 1 60); do
  EF_FORM=$(curl -s "http://127.0.0.1:$PORT/api/session/$EF_SESSION/form" \
    | python3 -c 'import sys,json;d=json.load(sys.stdin).get("data") or [];print(d[0]["id"] if d else "")' 2>/dev/null)
  [ -n "$EF_FORM" ] && break
  sleep 0.25
done
[ -n "$EF_FORM" ] || fail "no pending form appeared (elicit-form scenario)"
curl -s -o /dev/null -X POST "http://127.0.0.1:$PORT/api/session/$EF_SESSION/form/$EF_FORM/cancel"
wait_for_event turn.idle || fail "cancelling the form never settled the turn"
sleep 1
kill "$SSE_PID" 2>/dev/null || true

PENDING=$(curl -s "http://127.0.0.1:$PORT/api/session/$EF_SESSION/form" \
  | python3 -c 'import sys,json;print(len(json.load(sys.stdin).get("data") or []))')
[ "$PENDING" = "0" ] || fail "the cancelled form is still pending ($PENDING)"

check "elicit-form/cancel: form.cancelled, and the agent received action=cancel" <<'PY'
require('form.created')
require('form.cancelled')
require('turn.idle')
require('session.execution.succeeded')
if 'form.replied' in types:
    fail('a cancel was reported as a reply')
text = text_deltas()
marker = text.find('ELICIT ')
if marker < 0:
    fail('the agent never reported the elicitation answer; text=%r' % text[:200])
answer, _ = json.JSONDecoder().raw_decode(text[marker + len('ELICIT '):])
if answer.get('action') != 'cancel':
    fail('the agent received %r, expected action=cancel' % answer)
if answer.get('content'):
    fail('a cancel must carry no content: %r' % answer)
ok('form.cancelled → the agent received {action: cancel}')
PY

echo
echo "▸ scenario 15: title-and-model — the agent renames the session and moves its own model"

# Both halves come from the scenario itself: the fixture advertises a decodable
# model value, so nothing here overrides it.
start_bridge FAKE_ACP_SCENARIO=title-and-model FAKE_ACP_MODELS=1 FAKE_ACP_REPLY='moved myself'
subscribe 25
M_SESSION=$(new_session)
[ -n "$M_SESSION" ] || fail "no session id returned (title-and-model scenario)"
send_prompt "$M_SESSION" '{"parts":[{"type":"text","text":"move yourself"}]}'
wait_for_event turn.idle || fail "the title-and-model turn never settled"
sleep 1
kill "$SSE_PID" 2>/dev/null || true

# The client had to *act* on the update, not merely relay it.
grep -qF '[bridge] agent switched the model -> fake/model-2' "$ERR" \
  || fail "the bridge never logged the model switch it was told about"

check "title-and-model: session.renamed + session.model.selected" <<'PY'
require('session.renamed')
require('session.model.selected')
require('turn.idle')
require('session.execution.succeeded')
renamed = by_type('session.renamed')[-1]
if renamed.get('title') != 'Renamed by the scenario':
    fail('the title event carried %r' % renamed.get('title'))
selected = by_type('session.model.selected')[-1]
model = selected.get('model') or {}
if (model.get('providerID'), model.get('modelID')) != ('fake', 'model-2'):
    fail('the model event carried %r' % model)
previous = selected.get('previous') or {}
# `previous` is the model the session was genuinely on. Until the translator attached at
# agent startup, the fixture's session/new config update (model-1) never reached the
# handler, so `record.model` stayed unset and `previous` was always the placeholder —
# this assertion pinned that data loss. With the early attach it is the real prior model.
if previous.get('modelID') not in ('model-1', 'default'):
    fail('the event did not carry the model it moved away from: %r' % previous)
ok('renamed → %r; model → %s/%s (from %s)'
   % (renamed.get('title'), model.get('providerID'), model.get('modelID'), previous.get('modelID')))
PY

echo
echo "▸ scenario 16: interleaved — thought → text → tool → thought → text keeps the agent's order"

start_bridge FAKE_ACP_SCENARIO=interleaved FAKE_ACP_REPLY='interleaved-reply'
subscribe 25
I_SESSION=$(new_session)
[ -n "$I_SESSION" ] || fail "no session id returned (interleaved scenario)"
send_prompt "$I_SESSION" '{"parts":[{"type":"text","text":"interleave"}]}'
wait_for_event turn.idle || fail "the interleaved turn never settled (no turn.idle)"
sleep 1
kill "$SSE_PID" 2>/dev/null || true

check "interleaved: the client streams in order and accumulates per kind" <<'PY'
require('turn.idle')
require('session.execution.succeeded')
require('session.reasoning.started')
require('session.text.started')
require('session.tool.input.started')
require('session.tool.success')
require('session.reasoning.delta')
require('session.text.delta')

def index_of(name, start=0):
    for i in range(start, len(types)):
        if types[i] == name:
            return i
    return -1

if not (
    index_of('session.reasoning.started')
    < index_of('session.text.started')
    < index_of('session.tool.input.started')
):
    fail('the layers were not created in the agent\'s order: %s' % types[:20])
# The second thought and the second text arrive *after* the tool finished. They must
# open fresh parts: grouping by kind would destroy the agent's content order on reload.
tool_done = index_of('session.tool.success')
reasoning_starts = [i for i, t in enumerate(types) if t == 'session.reasoning.started']
text_starts = [i for i, t in enumerate(types) if t == 'session.text.started']
if len(reasoning_starts) != 2:
    fail('%d reasoning parts opened; expected thought → tool → thought boundaries' % len(reasoning_starts))
if len(text_starts) != 2:
    fail('%d text parts opened; expected text → tool → text boundaries' % len(text_starts))
if not (reasoning_starts[1] > tool_done and text_starts[1] > tool_done):
    fail('the post-tool parts were reordered before the tool')
ok('order preserved; distinct reasoning/text parts before and after the tool')
PY

python3 - "$PORT" "$I_SESSION" <<'PY' || exit 1
import json, sys, urllib.request
port, session = sys.argv[1], sys.argv[2]
with urllib.request.urlopen('http://127.0.0.1:%s/api/session/%s/message' % (port, session), timeout=5) as response:
    items = (json.load(response).get('data') or [])
assistants = [item for item in items if item.get('type') == 'assistant']
if not assistants:
    print('  ✗ no assistant message was recorded'); raise SystemExit(1)
content = assistants[0].get('content') or []
kinds = [entry.get('type') for entry in content]
if kinds != ['reasoning', 'text', 'tool', 'reasoning', 'text']:
    print('  ✗ projected content order is %s, expected [reasoning, text, tool, reasoning, text]' % kinds); raise SystemExit(1)
if content[0].get('text') != 'think one' or content[3].get('text') != 'think two':
    print('  ✗ reasoning boundaries were merged or reordered: %r / %r' % (content[0].get('text'), content[3].get('text'))); raise SystemExit(1)
if content[1].get('text') != 'text one' or not (content[4].get('text') or '').startswith('text two'):
    print('  ✗ text boundaries were merged or reordered: %r / %r' % (content[1].get('text'), content[4].get('text'))); raise SystemExit(1)
tool = content[2]
if tool.get('name') != 'echo-mid' or (tool.get('state') or {}).get('status') != 'completed':
    print('  ✗ the tool entry is wrong: %s' % tool); raise SystemExit(1)
print('  ✓ content[] = [reasoning, text, tool, reasoning, text]')
PY

echo
echo "▸ scenario 17: slow — a turn that is visibly running before it finishes"

# A longer pause than the fixture's default, so "not finished yet" is a state we
# observe rather than a race we win.
start_bridge FAKE_ACP_SCENARIO=slow FAKE_ACP_DELAY_MS=2500 FAKE_ACP_REPLY='slow: finally'
subscribe 25
S_SESSION=$(new_session)
[ -n "$S_SESSION" ] || fail "no session id returned (slow scenario)"
send_prompt "$S_SESSION" '{"parts":[{"type":"text","text":"take your time"}]}'
wait_for_event session.execution.started || fail "the slow turn never started"

check "slow: running, with nothing rendered yet" <<'PY'
require('turn.wait')
require('session.execution.started')
if 'session.execution.succeeded' in types or 'turn.idle' in types:
    fail('the turn reported finished before the agent answered')
if 'session.text.started' in types:
    fail('the client produced text before the agent sent any')
ok('running with no text and no terminal event yet')
PY

wait_for_event turn.idle || fail "the slow turn never settled (no turn.idle)"
sleep 0.5
kill "$SSE_PID" 2>/dev/null || true

check "slow: it then settles with the reply" <<'PY'
require('turn.idle')
require('session.execution.succeeded')
require('session.step.ended')
if 'slow: finally' not in text_deltas():
    fail('the reply never arrived: %r' % text_deltas()[:200])
ok('settled with the reply after the pause')
PY

echo
echo "▸ scenario 18: crash — the agent dies mid-turn and the client settles the turn"

start_bridge FAKE_ACP_SCENARIO=crash
subscribe 25
C_SESSION=$(new_session)
[ -n "$C_SESSION" ] || fail "no session id returned (crash scenario)"
send_prompt "$C_SESSION" '{"parts":[{"type":"text","text":"die"}]}'
wait_for_event turn.idle || fail "the crashed turn never settled (no turn.idle)"
sleep 1
kill "$SSE_PID" 2>/dev/null || true

check "crash: a dead agent fails the turn instead of leaving a spinner" <<'PY'
require('session.execution.failed')
require('session.step.failed')
require('turn.idle')
if 'session.execution.succeeded' in types:
    fail('a crashed turn was reported as succeeded')
ok('session.execution.failed + session.step.failed + turn.idle')
PY

# The agent's own death is visible, and the bridge outlives it: one bad session
# must not take the whole adapter down.
grep -qF '[acp] agent exited code=1' "$ERR" || fail "the agent's exit was not logged"
kill -0 "$BRIDGE_PID" 2>/dev/null || fail "the bridge died with the agent"
[ "$(curl -s -o /dev/null -w '%{http_code}' -m 3 "http://127.0.0.1:$PORT/api/health")" = "200" ] \
  || fail "the bridge stopped serving after the agent crashed"
echo "  ✓ agent exit logged; bridge still serving"

python3 - "$PORT" "$C_SESSION" <<'PY' || exit 1
import json, sys, urllib.request
port, session = sys.argv[1], sys.argv[2]
with urllib.request.urlopen('http://127.0.0.1:%s/api/session/%s/message' % (port, session), timeout=5) as response:
    items = (json.load(response).get('data') or [])
assistants = [item for item in items if item.get('type') == 'assistant']
if not assistants:
    print('  ✗ no assistant message was recorded'); raise SystemExit(1)
assistant = assistants[0]
error = (assistant.get('error') or {}).get('message') or ''
if 'agent exited' not in error:
    print('  ✗ the message does not record the crash: %r' % error); raise SystemExit(1)
text = ''.join(
    entry.get('text') or ''
    for entry in assistant.get('content') or []
    if entry.get('type') == 'text'
)
if 'about to die' not in text:
    print('  ✗ the partial text was lost: %r' % text); raise SystemExit(1)
tools = [entry for entry in assistant.get('content') or [] if entry.get('type') == 'tool']
if not tools or (tools[0].get('state') or {}).get('status') in (None, 'running'):
    print('  ✗ the abandoned tool is not terminal: %s' % tools); raise SystemExit(1)
print('  ✓ transcript: error=%r, text kept, tool=%s'
      % (error, (tools[0].get('state') or {}).get('status')))
PY

echo
echo "▸ scenario 19: slow session/new — the client waits on the agent, it does not finish early"

# Isolate the session start: the mid-turn pause is off, so the only delay is
# `session/new`. The prompt's HTTP response is the placeholder sent *after*
# beginTurn, so its wall time is the client's wait for the agent.
start_bridge FAKE_ACP_SCENARIO=slow FAKE_ACP_DELAY_SESSION_NEW_MS=2500 \
  FAKE_ACP_DELAY_MS=0 FAKE_ACP_REPLY='slow new session'
subscribe 25
N_SESSION=$(new_session)
[ -n "$N_SESSION" ] || fail "no session id returned (slow session/new scenario)"
PROMPT_TIME="$(mktemp)"
curl -s -o /dev/null -w '%{time_total}' -X POST \
  "http://127.0.0.1:$PORT/api/session/$N_SESSION/prompt" \
  -H 'content-type: application/json' \
  -d '{"parts":[{"type":"text","text":"start slowly"}]}' >"$PROMPT_TIME" &
PROMPT_PID=$!

wait_for_event session.inbox.delivered || fail "the prompt never reached the bridge"

check "slow session/new: no turn yet while the agent is still opening the session" <<'PY'
require('session.inbox.delivered')
if 'turn.wait' in types or 'session.step.started' in types:
    fail('the client started the turn before the agent answered session/new')
if 'session.execution.succeeded' in types or 'turn.idle' in types:
    fail('the turn finished before the session existed')
ok('delivered, but still no turn.wait while session/new is in flight')
PY

wait "$PROMPT_PID" || true
ELAPSED="$(cat "$PROMPT_TIME")"
rm -f "$PROMPT_TIME"
case "$ELAPSED" in
  ''|*[!0-9.]*) fail "could not measure the prompt's wall time: '$ELAPSED'" ;;
esac
# Independent proof the delay was actually in force: without it the placeholder
# would come back in milliseconds and the check above could pass by accident.
python3 -c "import sys; sys.exit(0 if float('$ELAPSED') >= 1.5 else 1)" \
  || fail "the prompt returned in ${ELAPSED}s; the session/new delay was not in force"

wait_for_event turn.wait || fail "the turn never started after the slow session/new"
wait_for_event turn.idle || fail "the slow session/new turn never settled"
sleep 0.5
kill "$SSE_PID" 2>/dev/null || true

check "slow session/new: it then runs and settles normally" <<'PY'
require('turn.wait')
require('session.execution.succeeded')
require('turn.idle')
if 'slow new session' not in text_deltas():
    fail('the reply never arrived: %r' % text_deltas()[:200])
ok('started late, then settled with the reply')
PY

echo
echo "▸ scenario 20: error-response — a JSON-RPC error in place of a result still settles the turn"

start_bridge FAKE_ACP_SCENARIO=error-response
subscribe 25
X_SESSION=$(new_session)
[ -n "$X_SESSION" ] || fail "no session id returned (error-response scenario)"
send_prompt "$X_SESSION" '{"parts":[{"type":"text","text":"fail the request"}]}'
wait_for_event turn.idle || fail "the error-response turn never settled (no turn.idle)"
sleep 1
kill "$SSE_PID" 2>/dev/null || true

check "error-response: a failed request is terminal, and no text is invented" <<'PY'
require('session.execution.failed')
require('session.step.failed')
require('turn.idle')
if 'session.execution.succeeded' in types:
    fail('a failed request was reported as succeeded')
# The agent never sent content, so the client must not have rendered any: this is
# where a client that turns "no result" into an empty reply would be caught.
if 'session.text.started' in types or 'session.text.delta' in types:
    fail('the client rendered text for a prompt that produced none')
if any(t and t.startswith('session.tool.') for t in types):
    fail('the failed request produced tool events: %s' % types)
ok('request failed → terminal, and nothing was invented')
PY

python3 - "$PORT" "$X_SESSION" <<'PY' || exit 1
import json, sys, urllib.request
port, session = sys.argv[1], sys.argv[2]
with urllib.request.urlopen('http://127.0.0.1:%s/api/session/%s/message' % (port, session), timeout=5) as response:
    items = (json.load(response).get('data') or [])
assistants = [item for item in items if item.get('type') == 'assistant']
if not assistants:
    print('  ✗ no assistant message was recorded'); raise SystemExit(1)
assistant = assistants[0]
error = (assistant.get('error') or {}).get('message') or ''
if 'refused this prompt' not in error:
    print('  ✗ the transcript does not record the request failure: %r' % error); raise SystemExit(1)
content = assistant.get('content') or []
if content:
    print('  ✗ the failed turn still projected content: %s' % content); raise SystemExit(1)
print('  ✓ transcript: error=%r, content=[]' % error)
PY

echo
echo "✓ smoke passed"
