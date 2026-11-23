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
★ **"export it" is not enough**: a script has to *own* this directory, or it is measuring the
operator's config (see #10 — the same rule, and it cost a whole 4-version grid).

---

## 9. ★ Keep the evidence, or the key question becomes unanswerable

**Symptom**: `cleanup` ran `rm -rf "$WORK"`, and the Continue failure's actual question was "was
that session in the map?" — **deleted with the workspace**.

**Do**: `KEEP=1` keeps it, and the failure path prints where.

---

## 10. ★★ A probe that only OPENS a picker can still change what you measure

**Symptom**: the matrix graded `opencode acp` **BLOCKED** on opencode v2.1.4 with
`Error: Internal error: No permission to use model 'deepseek-v4-flash-inhouse-yd'`, while the
same command answers correctly when run by hand.

**Cause**: `feature_probes` step (b) opens `/model` and presses Escape without choosing. The
TUI's model choice is **global**, not per session, and the picker filters by **prefix**. The
order is the picker's own, not the config's: in the config this provider lists 40 models with
`MiniMax-M3` first and `deepseek-flash` at position 14, while the picker sorts them its own way
and opens on a different entry. Pressing Enter with nothing selected therefore lands on whichever
model sorts first — **not** the one the config names (here a sibling model on the same
provider, which the account had no access to), and the
turn failed there. Measured in **4 of 4** full runs plus a single-cell run.
...
⚠️ The exact position depends on the picker's sort and on which models a machine can see, so do
not quote a number in a test — the rule is "the first row is not your configured model".

**Why it misleads**: the verdict reads "the agent's credentials are wrong". The agent never ran
— there is not one `[acp] [agent]` line in the log; the error is the TUI's own model plumbing.
A dropped probe therefore buys three wrong `BLOCKED` cells, one per version.

**Cause, deeper — and the part that made a whole 4-version grid meaningless**: the matrix did
**not** apply #8. `OPENCODE_CONFIG_DIR` was unset, so the TUI under test read the owner's
`~/.config/opencode/opencode.json`, and the model — `deepseek-v4-flash-inhouse-yd`, the one at
index 0 — came from there. Measured: give the matrix a private config dir and the same
`opencode acp` cell **passes on v2.1.4** (isolated, the agent advertises 13 of its own models,
`currentValue: opencode/tidepool-alpha-free`); under the owner's config it fails on **all four**
versions. A matrix that inherits the operator's config measures the operator's config — on every
version — and reports the result as the version's fault.

**Do**: isolate the config dir **by default**, not behind a skip switch; a skip switch means the
default stays wrong.

```bash
TUI_CONFIG_DIR="$WORK/tui-config"; mkdir -p "$TUI_CONFIG_DIR"
printf '{"session":{"verbosity":"high"}}\n' > "$TUI_CONFIG_DIR/cli.json"
printf '{"session":{"verbosity":"high"}}\n' > "$TUI_CONFIG_DIR/tui.json"
export OPENCODE_CONFIG_DIR="$TUI_CONFIG_DIR"          # default; USE_REAL_TUI_CONFIG=1 opts out
```

**Why index 0 wins**: the picker filters by **prefix**, and a list whose first row is a model the
operator is not authorized for turns any text typed into a filter into a selection of *that* row.
With the isolated dir the first row is a model the agent can actually serve, so the same probe is
harmless — but the rule still stands: **a probe that is not the subject of the assertion must not
be able to mutate state.** `SKIP_MODEL_PROBE=1` exists for that and is otherwise unnecessary.

★ The picker **writes `~/.config/opencode/tui.json`** — the owner's own file. Take a restore
point before a matrix run and compare checksums after it (`openssl md5`), the same way a probe of
a database is fenced. Measured across this run's 4 sweeps: untouched, mtime `Oct 20 16:58`.

---

## 11. ★★ `esc interrupt` is not a completion test — it SCROLLS

**Symptom**: one full matrix run reported three cells as "the turn never finished (esc interrupt
still up after ~4min)". The panes saved **2 seconds later** contained **zero** `esc interrupt`
(1856 bytes for qwen, 2529 for gemini) and the agent's own error row was right there.

**Cause**: the wait loop checked `grep -q 'esc interrupt'` **first** and only looked for the
reply inside `if ! … esc interrupt …`. The hint is one row, and it scrolls out of a 42-row pane
the moment the error row wraps — so a **finished** turn never satisfied the terminator and the
loop ran its full 150 × 2 s.

**Do**: order the loop's tests **outcome first, busy second, dead third**, and never `continue`
on "hint present" alone — both its presence and its absence are unreliable once the pane is full.

```bash
# 1. the agent's own answer (its echo excluded, see 13)
if printf '%s' "$body" | grep -v "Reply with exactly" | grep -q 'MATRIX_OK\|Authentication required'; then
  done_turn=1; break
fi
# 2. the TUI is busy: wait. Absence of the hint is NOT a verdict on its own.
printf '%s' "$body" | grep -q 'esc interrupt' && continue
# 3. our own bridge error: the agent never came up
if printf '%s' "$body" | grep -q 'could not start the agent\|agent exited'; then dead=1; break; fi
```

★ A failure message must also report what was **observed** (`TUI busy: no`), not what the script
expected — "esc interrupt still up" was measurably false for every cell it cost a run, and that
wording sends the next reader to the wrong component.

---

## 12. ★ Our own error row matches "the agent answered"

**Symptom**: a cell whose agent process had **died** was graded "✓ the reply rendered on screen".

**Cause**: the success test was `grep -q 'MATRIX_OK\|Authentication required\|Error:'`, and our own
bridge row reads `Error: could not start the agent: agent exited: ACP connection closed`. The dead
agent matched **our** `Error:` and the cell passed. The `error` arm had the same hole one word over:
a dead agent was reported as **BLOCKED**, i.e. as the agent's credentials.

**Do**: exclude our own strings before matching the agent's, and test `dead` first as a **FAIL**
of its own — corroborated from the log, which the bridge writes independently of any rendering:

```bash
if grep -aq 'agent exited code=' "$log"; then fail "$name: the agent process did not come up"; fi
```

**Rule**: `Error:` alone never means "the agent replied". The narrow, real shape is
`Authentication required` / the agent's own API error, and every other `Error:` deserves a look at
whose row it is.

---

## 13. ★ The prompt's echo counts as the answer — and tmux has no `/usr/sbin`

**Symptom (a)**: "the reply rendered on screen" on a pane where `MATRIX_OK` appeared **only** in
the composer and in the user row we typed. **Cause**: the needle is literally the prompt text.

**Do**: drop the echo before every reply assertion — `grep -v "Reply with exactly"`.

**Symptom (b)**: `gemini --acp` died at startup with
`uncaught Error: spawnSync sysctl ENOENT`, before any session existed, and the cell's failure
looked like a TUI, model or version problem.

**Cause**: tmux ran with `…:/usr/local/bin:/usr/bin:/bin` — **no `/usr/sbin`**, where `sysctl`
lives. Not the agent's credentials, and nothing to do with opencode: the agent was launched into an
environment that could not start it.

**Do**: append the system sbin directories in the script, and make the launch environment part of
the evidence.

```bash
case ":$PATH:" in *":/usr/sbin:"*) ;; *) PATH="$PATH:/usr/sbin" ;; esac
case ":$PATH:" in *":/sbin:"*) ;; *) PATH="$PATH:/sbin" ;; esac
export PATH
```

★ On any "the agent exited" symptom, print **the PATH it was launched with** before blaming the
agent. Here the agent's own stderr said exactly what was missing; nobody read it for an hour
because the cell's verdict was already "blocked".

---

## 14. ★★ Wait for a NEW row by ID, not by count — and do not exclude the agent you ship

**Symptom**: turn 3 ("which word did I ask for last message?") answered with turn 1's text, and a
model that had obviously remembered was graded as having forgotten.

**Cause**: the wait loop counted completed assistant rows and returned the *newest* one it found.
Two independent mistakes met there: the bridge can **complete an existing row** instead of
appending one, so the count never grows and the loop falls through to whatever is there; and the
API returns newest-first, so "the last element" is the *oldest* row. Track row **ids** against the
set that existed before the prompt, and take the first id that is new and done.

**Second mistake, same family**: the matrix excluded `opencode acp` from its agent list, reasoning
"it is the TUI's own binary, so the version axis covers it". It does not — the agent command is
built from the binary the version selects, so `2.0.32 × opencode` is a 2.0.32 ACP server driven by
a 2.0.32 TUI, which is the combination the product ships. Leaving it out was blind in exactly the
place that mattered: v2.0.18's ACP cannot see a provider from `opencode.json`, v2.0.32 can, and
nothing in the grid would have said so. **The agent your product launches is a cell.**

**Rule**: a wait condition on a growing list must name the element (id), not its arrival order. A
matrix must include the agent the product starts by default.

## 15. ★★ A fake agent that "never answers" cannot find the real cancel bug — a tool must be RUNNING

**Symptom**: `MODE=cancel` was green on 4 TUI releases while, in the owner's real session, double
Esc left both the prompt-footer spinner and the tool row spinning. The bridge was right throughout:
`prompt settled stopReason="cancelled"`, `session.execution.interrupted {reason:"user"}` emitted,
`/api/session/active` empty.

**Cause**: the tool event sent on a cancel carried `content: []`. The spec types it `NonEmptyArray`
(`minItems: 1`), and opencode v2.3's client, with image preview off (the default), rewrites tool
content through `[r(n[0]), ...]`, where `r` reads `n[0].type`. On `[]` that is `undefined.type`: the
handler throws (TUI log: `uncaught exception … evaluating 'd.type'`), and the
`session.execution.interrupted` later in the same dispatch — the event that clears the spinner — is
lost.

**Why the test missed it**: the old cancel scenario only hung the prompt, with **no tool in flight**,
so it never reached a tool event carrying `content`. A real agent (dsh) is in the middle of a shell
tool when cancelled, and its own `failed` update arrives **after** the cancel. `MODE=cancel` now
defaults to `FAKE_ACP_HANG_TOOL=1` to reproduce that: ✗ before the fix, ✓ on all 4 releases after.

**Where to look**: when the screen and the bridge disagree, read **the TUI's own log**
(`~/.opencode-acp-client/opencode/<agent>/data/opencode/log/opencode.log`), not only the bridge's.
To place a minified name like `d.type`, search the installed binary itself (the JS is embedded in
it) rather than guessing from another release's source.

**Rule**: a cancel test must have a tool **running**, with the agent's terminal update arriving
after the cancel. Where the spec says an array is non-empty, never send `[]` — omit the field when
there is nothing, or send one empty text entry when it is required.

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
