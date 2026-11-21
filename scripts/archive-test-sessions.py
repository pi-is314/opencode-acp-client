#!/usr/bin/env python3
"""Archive the sessions a real-agent test leaves in the agent's own store.

Real-agent runs (AGENT=... against dsh or any agent with a session store) create sessions
in the agent's storage, not ours: dsh keeps them under ~/.dsh/sessions/<workspace>/<sid>/,
and they show up in its web UI. dsh advertises no `sessionCapabilities.delete` (measured:
`session/delete` hangs unanswered), so ACP cannot remove them — the only honest cleanup
is to move them out, which is what this does.

Safe by construction: it only archives
  - workspaces whose cwd is a test pattern (temp dirs, e2e dirs), or
  - sessions created today inside real workspaces that are empty or whose user messages
    match known bridge-test markers,
and it MOVES (never deletes) into ~/.dsh/sessions-archived-bridge-tests-<ts>/, writing a
companion inventory JSON beside the archived sets, matching the owner's own convention
(sessions-archived-* + sessions-*-inventory.json).

Run it after any real-agent test:
    python3 scripts/archive-test-sessions.py
"""
import json, os, re, shutil, subprocess, sys, datetime

DSH = os.path.expanduser("~/.dsh/sessions")
TS = datetime.datetime.now().strftime("%Y-%m-%dT%H-%M-%S")
DEST = os.path.expanduser(f"~/.dsh/sessions-archived-bridge-tests-{TS}")
INV = os.path.expanduser(f"~/.dsh/sessions-archived-bridge-tests-{TS}.json")

# workspace dirs that are certainly test cwd (temp dirs, e2e dirs)
# `--tmp*`/`--private-tmp*` cover the suffixed test rooms too (`--tmp-acpwork--`,
# `--private-tmp-acpwork--`): the exact-match form missed the dsh ACP probes, which
# left titled test sessions (HARNESS_OK, "Run echo command then reply DONE").
TEST_WS = re.compile(r"^(--private-tmp.*|--tmp.*|.*-T-tmp\.[A-Za-z0-9]+|.*-T-oac-record-[A-Za-z0-9]+|.*-T-recws[0-9]*-[A-Za-z0-9]+|.*goose-acp-e2e.*|.*sdke2e.*|--var-folders.*tmp.*)--$")

# Prompt fragments that ONLY this repository's tests send. Two rules, both load-bearing:
#   1. nothing that could plausibly appear in a real conversation — "say OK" and
#      "run it" were here once and would have archived genuine sessions;
#   2. nothing derived from a real user session (an early version carried real
#      prompts and skill invocations, which both leaks the user's work and widens
#      the blast radius of a mistaken archive).
MARKERS = ("<skill_content", "Reply with exactly", "FIRST_TURN_MARKER", "SIDE_ANSWER_MARKER",
           "patrol anchor line", "What did I ask you to reply", "after the move",
           "after the restart", "run the echo tool", "remember this line", "exported turn")

def read_msgs(ws, sid):
    # v4 stores `user/message`; older stores used `user_message`/`message`. Reading
    # only the old names made every v4 session look empty, so a real workspace's
    # "empty" rule silently archived nothing and the test-workspace rule was the
    # only one that ever fired (found while cleaning up two days of runs).
    f = None
    for name in ("session.v4.jsonl.zstd", "session.v3.jsonl.zstd"):
        candidate = os.path.join(DSH, ws, sid, name)
        if os.path.exists(candidate):
            f = candidate
            break
    if f is None: return None, []
    try:
        out = subprocess.run(["zstd", "-dc", f], capture_output=True, timeout=10)
        texts, empty = [], True
        for line in out.stdout.decode("utf-8", "replace").splitlines():
            try: o = json.loads(line)
            except: continue
            t = o.get("type")
            if t in ("user/message", "user_message", "message"):
                empty = False
                c = o.get("content") or o.get("text") or ""
                if isinstance(c, list):
                    c = " ".join(str(b.get("text","") if isinstance(b,dict) else b) for b in c)
                texts.append(str(c))
        return empty, texts
    except Exception:
        return None, []

DRY = "--dry-run" in sys.argv
entries = []
for ws in sorted(os.listdir(DSH)):
    wspath = os.path.join(DSH, ws)
    if not os.path.isdir(wspath) or ws.startswith("sessions-"): continue
    if TEST_WS.match(ws):
        for sid in sorted(os.listdir(wspath)):
            sp = os.path.join(wspath, sid)
            if os.path.isdir(sp):
                entries.append((ws, sid, "test-workspace"))
        continue
    # real workspaces: only sessions created today that are empty or test-marked
    for sid in sorted(os.listdir(wspath)):
        sp = os.path.join(wspath, sid)
        if not os.path.isdir(sp): continue
        try: created = os.path.getmtime(sp)
        except: continue
        today = datetime.datetime.fromtimestamp(created).strftime("%Y-%m-%d")
        if today != datetime.datetime.now().strftime("%Y-%m-%d"): continue
        empty, texts = read_msgs(ws, sid)
        if empty is None: continue
        marked = any(any(m in t for m in MARKERS) for t in texts)
        if empty or marked:
            entries.append((ws, sid, "empty" if empty else "test-content"))

total_bytes = 0
moved = []
if DRY:
    for ws, sid, why in entries:
        print(f"would archive {ws}/{sid} ({why})")
    print(f"dry run: {len(entries)} session(s) selected")
    sys.exit(0)
for ws, sid, why in entries:
    src = os.path.join(DSH, ws, sid)
    dst = os.path.join(DEST, ws, sid)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    try:
        for f in os.listdir(src):
            total_bytes += os.path.getsize(os.path.join(src, f))
        shutil.move(src, dst)
        moved.append({"sid": sid, "ws": ws, "why": why})
    except Exception as e:
        print(f"skip {ws}/{sid}: {e}", file=sys.stderr)
# drop now-empty ws dirs
for ws in {e["ws"] for e in moved}:
    p = os.path.join(DSH, ws)
    try:
        if os.path.isdir(p) and not os.listdir(p): os.rmdir(p)
    except: pass

# A session's PROJECTION file is what the web UI lists; leaving it behind showed an
# entry whose session directory was gone ("未命名" and unloadable on click) even
# after the session itself had been archived. Move the projections with the
# sessions, and prune their entries from the aggregate cache.
PROJ = os.path.expanduser("~/.dsh/storages/session_projcache/sessions")
AGG = os.path.expanduser("~/.dsh/storages/session_projcache.json")
projections = 0
for m in moved:
    for name in (m["sid"] + ".json", "session-" + m["sid"] + ".json"):
        src = os.path.join(PROJ, name)
        if not os.path.exists(src):
            continue
        dst = os.path.join(DEST, "_projections", name)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.move(src, dst)
        projections += 1
if projections and os.path.exists(AGG):
    shutil.copy2(AGG, AGG + f".bak-{TS}")
    try:
        data = json.load(open(AGG))
        table = data.get("tables", {}).get("sessions", {})
        ids = {m["sid"] for m in moved}
        for key in list(table):
            if key in ids or key.removeprefix("session-") in ids or "session-" + key in ids:
                del table[key]
        json.dump(data, open(AGG, "w"), indent=2, ensure_ascii=False)
    except Exception as e:
        print(f"could not prune the projection cache: {e}", file=sys.stderr)

inv = {"archivedAt": datetime.datetime.now().isoformat(),
       "sessions": len(moved), "bytes": total_bytes, "projections": projections,
       "note": "bridge e2e/real-agent test sessions (test workspaces + today's empty/marker sessions)",
       "entries": moved}
with open(INV, "w") as f: json.dump(inv, f, indent=2, ensure_ascii=False)
print(f"archived {len(moved)} sessions ({total_bytes} bytes) -> {DEST}")
by = {}
for e in moved: by[e["why"]] = by.get(e["why"], 0) + 1
print("by reason:", by)
