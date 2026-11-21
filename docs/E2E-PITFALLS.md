# Pitfalls when writing e2e scripts

> This page records the traps these **test scripts** fall into. Getting one compatibility matrix
> to run once meant roughly a dozen failed gate runs — and **every single cause was in the scripts.
> Not one line of product code changed.**
>
> These are not "prefer not to" suggestions. Each one has already cost a whole gate run.
> Read this before editing anything under `scripts/e2e-*.sh`.

---

## 1. ★★ Never pin the port

**Symptom**: `PORT="${PORT:-4811}"`.

The failure chain, every link of which looked like the version under test was broken:

```
a previous run is killed → its tmux session goes away, its bridge keeps listening on 4811
  ↓
the new bridge starts → listen EADDRINUSE → it crashes
  ↓
but /api/info still answers (from the OLD bridge) → "✓ adapter is up" passes
  ↓
the TUI connects to the OLD bridge and opens a session from ANOTHER workspace
  ↓
this run's bridge.log stays 0 bytes; every request lands in the previous run's log
  ↓
symptoms: "the prompt never reached the bridge", "the search row is missing", "TUI never became ready"
```

**One pinned port disguised itself as three different bugs in a single day.**

**Do**: probe for a free one.

```bash
if [ -z "${PORT:-}" ]; then
  for _try in $(seq 1 50); do
    PORT=$((4400 + RANDOM % 400))
    lsof -i ":$PORT" >/dev/null 2>&1 || break
  done
fi
```

---

## 2. ★★ Never wait a fixed duration for something to happen

**Symptom**: `send_prompt() { tmux send-keys "$1"; sleep 1.6; tmux send-keys Enter; }`.

Under load the Enter lands before the composer takes keystrokes. The prompt is never submitted,
nothing appears, and every downstream assertion measures an empty screen — **which reads exactly
like a translation-layer regression**.

**The subtle part**: the first fix replaced the sleep with "wait until the text appears on screen".
**That is still wrong.** Once this test has sent a prompt before, that text is *already* on screen
in the user row, so the wait returns instantly whether or not the keystroke landed.

**Do**: wait for the **behaviour**, not a duration and not a screen string.

```bash
# a NEW /prompt in the bridge log is the only honest signal that a submission happened
before="$(grep -c 'POST /api/session/[^/]*/prompt' "$LOG" 2>/dev/null)"; before="${before:-0}"
for attempt in 1 2 3; do
  tmux send-keys "$1"; sleep 1; tmux send-keys Enter; sleep 1.5
  after="$(grep -c ...)"; after="${after:-0}"
  [ "$after" -gt "$before" ] && return 0
  tmux send-keys C-u      # clear a half-typed line before retrying
done
```

★ **`grep -c` prints `0` AND exits 1** when nothing matches, so `$(grep -c … || echo 0)` yields
**two lines of `0`** and every later numeric comparison fails. Use `${var:-0}`.

---

## 3. ★★ Never pin the client's own UI wording into an assertion

**Symptom**: `grep -q 'Explored: 1 search'`.

That separator changed between releases — v2.0.0 renders `Explored — 1 search`, v2.2.7 renders
`Explored: 1 search`. The assertion therefore **only held on the newest release** and reported
"grouping broke" on the oldest.

**Worse**: v2.0.0 does not group a lone `websearch` at all (only grep/glob count as exploration),
so that row is not broken — it does not exist.

**Do**, in this order:

1. **Match the shape**, not the punctuation: `Explored[^a-zA-Z0-9]*[0-9]+[^a-zA-Z0-9]*search`
2. **Ask whose promise the row is**. The client's grouping policy is **not this bridge's promise**
   → record a `note`, do not fail
3. If it matters, split the commands into two groups (those that render this bridge's data vs those
   that read the client's own store)

```bash
PATROL_OURS=" /compact /btw /undo /model /sessions"     # a crash here is ours
# the rest (/timeline /stats /diff …) read the client's own stores
```

---

## 4. ★ Cleanup may only kill its own things

**Symptom**: `for sock in /tmp/tmux-*/oac-e2e-*` — which **killed a concurrent run's tmux server**.

The other run then found `no server running` at its first pane capture — **and it looked like that
run's own bug**.

**Also measured**: pattern-matching every bridge on the machine by command line — same outcome,
killed the bridge a concurrent run was using.

**Do**:

- **tmux**: use a socket named after this process, kill only that one
- **processes**: walk the process **tree down from your own pid**, never a machine-wide match

```bash
ps -o pid= -o ppid= -ax | awk -v root="$$" '{ ppid[$1]=$2 } END {
  ours[root]=1; changed=1
  while (changed) { changed=0
    for (p in ppid) if (!(p in ours) && (ppid[p] in ours)) { ours[p]=1; changed=1 } }
  for (p in ours) if (p != root) print p }'
```

**And**: signal handlers must `exit`.

```bash
trap cleanup EXIT
trap 'cleanup; exit 143' TERM      # without exit, the script carries on and its children keep the port
```

---

## 5. ★ Print the screen when a wait fails

**Symptom**: three gate runs failed in three different modes, all reporting "the TUI never became
ready", while the bridge log proved the start-up handshake had completed.

**Why it was invisible**: the saved pane was captured **after** the wait ended, by which time the
screen had long recovered. From the logs alone, one symptom looked like three separate bugs.

**Do**: capture and print **at the moment of the timeout**, with the pane's state.

```bash
echo "  ! timed out waiting for $2" >&2
echo "  ! screen at timeout ($(tmux display-message -p -t "$CLIENT" '#{session_name}:#{window_index}.#{pane_index} #{pane_width}x#{pane_height} dead=#{pane_dead}')):" >&2
tmux capture-pane -p -t "$CLIENT" >&2
```

**That one line** is what later showed the screen held a **What's new dialog**, not a failed start.

---

## 6. ★ Client modals block everything — handle them inside the wait

**Symptom**: v2.3.0 opens "What's new in \<version\>" on first launch, `scroll ↑/↓  ok`, holding the
keyboard.

**Consequence**: **19** `wait_for_pane 'Ask anything'` sites timed out; in `e2e-agent-matrix.sh`,
4 of 8 agents failed (`opencode acp` / dsh-acp / gemini never became ready; codex's prompt stayed in the
composer, which then produced a spurious Continue-line failure).

**Do**: handle it **inside the wait function**, not at nineteen call sites.

```bash
dismiss_announcements() {
  [ "${ANNOUNCEMENTS:-0}" -ge 2 ] && return 1        # bounded: do not fight a mode testing a dialog
  tmux capture-pane -p -t "$CLIENT" 2>/dev/null | grep -qE "What's new in|scroll ↑/↓.*ok" || return 1
  tmux send-keys -t "$CLIENT" Enter
  ANNOUNCEMENTS=$(( ${ANNOUNCEMENTS:-0} + 1 ))
}
```

★ **Every test run is a first run**: the workspace is temporary, so this dialog shows **every time**.
A screen a user sees once is, here, seen always.

---

## 7. ★ Wait for "finished writing", not for "a while"

**Symptom**: `sleep 4` after exit, then capture, then assert the Continue line. The failure said
"the rewrite did not run".

**Truth**: the epilogue rewrite is attached to the child's **`'close'`** event (not `'exit'`), so it
prints only after the TUI's stdio has drained. `scripts/e2e-epilogue.sh` had always waited for a log
marker; the matrix had not.

★ The result was a cell that **passed alone and failed in the full run** — the classic timing flake
that makes a feature look broken.

---

## 8. ★ Pin the environment that your assertions depend on

**Symptom**: v2.3.0 changed the `session.verbosity` default to `low`, which **collapses a run of
tool calls into one activity row**. Every "tool card is visible" assertion failed — **and none of
it was this bridge's doing**.

**Do**: have the acceptance script **pin** the UI settings its assertions depend on.

```bash
printf '{"session":{"verbosity":"high"}}\n' > "$TUI_CONFIG_DIR/cli.json"
export OPENCODE_CONFIG_DIR="$TUI_CONFIG_DIR"
```

★ **The config file name changes**: since v2.3.0 it is `cli.json`; `tui.json` is read only to
migrate. Write both so the pin holds on releases either side.
★ What is pinned is the **harness's** preference, not product behaviour — a user who prefers the
summary keeps it.

---

## 9. ★ Keep the evidence, or the key question becomes unanswerable

**Symptom**: `cleanup` ran `rm -rf "$WORK"`, and the Continue failure's actual question was "was
that session in the map?" — **deleted with the workspace**.

**Do**: `KEEP=1` keeps it, and the failure path prints where.

---

## Self-check

After touching `scripts/e2e-*.sh`:

- [ ] the port is **probed**, not pinned
- [ ] every wait is for **an observable event** (a log line, a screen element), not for seconds
- [ ] `grep -c` results are defaulted with `${var:-0}`; no `|| echo 0`
- [ ] assertions match **shape**, not one release's **punctuation**
- [ ] the client's own UI policy (grouping, collapsing, dialogs) is a **note or pinned**, never
      treated as this bridge's promise
- [ ] `cleanup` kills only **its own** processes / sockets, and every `trap` **exits**
- [ ] a timed-out wait **prints the screen**
- [ ] UI settings the assertions depend on are **pinned explicitly**
- [ ] a failure can be re-read later with `KEEP=1`

---

## Related facts (so they are not rediscovered)

- **opencode v2 has no terminal-level TUI automation of its own**: its TUI tests are component tests
  (`.test.tsx`) and its e2e is Playwright against the web app. `e2e-real-tui.sh` (tmux + capture)
  is the extra layer this repository adds — and it is what catches the problems component tests
  cannot see (whether the bridge's event stream renders).
- **Windows has no tmux**, so the real-TUI acceptance runs on macOS and Linux only; Windows runs the
  unit suite. That matches upstream and is recorded in [COMPAT-OPENCODE.md](COMPAT-OPENCODE.md)
  rather than pretended otherwise.
- The design of the compatibility matrix (why boundaries and not all releases, why three layers
  rather than 360 cells) is in the header comment of `scripts/compat-matrix.sh`.
