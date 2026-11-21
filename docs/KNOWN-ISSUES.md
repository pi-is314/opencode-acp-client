# Known issues and limits

> 中文版：[KNOWN-ISSUES.zh.md](KNOWN-ISSUES.zh.md)

> This page keeps only what is **still open** — unresolved problems and known limits. Fixed
> defects are not recorded in this repository; they live in a local, version-control-excluded
> document together with their reproductions and causes.

## A round of messages disappears while you type 🟡 (observed, not reproduced, not located)

**Symptom.** While typing in the composer, the **most recent completed exchange** (the last user
message plus its reply) vanishes from the transcript.

**Status.** Not seen again recently, **not located and not ruled out**. This is not "fixed" —
nothing was changed for it.

**If it happens again**, run with the probe; it splits the single question "did the bridge hand over the newest
message":

```bash
OPENCODE_ACP_CLIENT_MESSAGE_PROBE=1 oc-acp-client -- <agent>
```

**Adjacent facts** (independent conclusions, none of them the cause):

- An idle SSE stream is reaped by the HTTP stack after roughly 45 s, and the client then
  reconnects and re-runs its whole bootstrap. **That part is handled**: `/api/event` emits a
  `: keepalive` comment frame every 15 s.
- The client's protection only covers "the user row + an unacknowledged send". The mechanism
  exists; the trigger is unknown.

## Known limit: after a restart, `!` commands are not in the session history (same as upstream — **not a bug**)

**Reported**: `!ls` works immediately; quit, relaunch, and reopen the session from a tab or the
session list — **the conversation is all there, the shell command is not**.

### Why: a `!` command never goes through an ACP agent

Three pieces of evidence, read from the v2.0.28 source:

1. **The TUI uses a separate HTTP route** for shell, in parallel with the conversation:

   ```ts
   // packages/tui/src/component/prompt/index.tsx:1306
   if (currentMode === "shell") {
     const send = () => client.api.session.shell({ sessionID: target, command: inputText })
   ```

   The conversation goes through `session.prompt` (the agent records it); shell goes through
   `session.shell` (the agent is not involved).

2. **Upstream's shell service says it keeps no session/message state**:

   ```text
   packages/core/src/shell.ts:57-59
     * Each `create` spawns one shell command, captures combined stdout/stderr to a
     * file-backed output by cursor. No session, message, or permission state lives here.
   ```

3. **All three shell events are `ephemeral`**, while `session.message.*` is `durable`:

   ```ts
   // packages/schema/src/shell.ts:58-61
   const Created = ephemeral({ type: "shell.created", ... })
   const Exited  = ephemeral({ type: "shell.exited",  ... })
   const Deleted = ephemeral({ type: "shell.deleted", ... })
   ```

This bridge is the same: `startShell` makes **zero ACP calls**, it spawns directly. And ACP has
no "run a shell" method at all — its `terminal/*` runs the other way (the agent asks the client to
run a command), and this bridge deliberately does not announce that capability (rule 1).

### Conclusion

```text
conversation → through ACP → the agent records it → session/load replays it after a restart
!shell       → not through ACP → nobody records it → nothing to replay after a restart
```

**Upstream opencode v2 behaves identically** — its shell is not in the history after a restart
either. So this is a known limit that matches upstream, not a defect here.

Regression evidence: the real-TUI `MODE=shell-history` assertions (`scripts/e2e-real-tui.sh`), which run in `pnpm verify`.

---

# Resuming a session: the conclusions

Measured with `dsh --profile acp` (the built-in ACP profile). Three
complaints: the title does not change, "resume" does not seem to work, and the exit line becomes
the native `opencode -s …`. Each was traced to the end; the conclusions follow.

## Open / undecided (none of these is a one-sided fix)

1. **Some agents have no title surface** (`@deepseek-ai/dsh-acp` contains **zero** occurrences of
   `session_info_update`, and its `session/list` entries carry no title). The answer is a
   **deterministic fallback title** (first input, one line, at most 48 characters, `…` if longer;
   `derivedTitle()`). Priority: agent title > user rename > fallback > directory name/marker;
   `SessionRecord.titleFrom*` records the source, so the fallback never overwrites something
   better. The fallback is **not written to the session map** (that map holds ids, not message
   text).
2. **Starting with N tabs spawns N agent processes** (`/message`, `/api/model` and
   `/api/command` all start one along the way; two tabs measured two loads). Under the built-in
   `acp` profile those loads **get no history at all** — pure waste, and single-writer backends
   step on each other. The fix (lazy loading) depends on the TUI's internal read order, which is
   medium-high risk and needs its own round of verification.
3. **The fallback when a resume fails**: today it starts a new session and says so. The stricter
   alternative is to create nothing, leave the tab empty, and create on the next input. Both are
   honest; they differ in the cost of failure (one extra empty session in the agent's store)
   against availability.
4. A fresh launch pre-creates an empty shell session and eagerly starts an agent, while the TUI
   itself does **not** open a session (measured: with no input at all, one session and one agent
   for the whole run — the `empty` scenario in `scripts/e2e-epilogue.sh`). But **the first submit
   POSTs the TUI's own session**, so there end up being two sessions and two agents, and the
   pre-created one stays empty forever. (`GET /api/model`'s pending path can also start the
   catalog, so whether the pre-create step is still needed deserves its own measurement.)

---

## ★ Fact one: after `session/resume`, whether the model still "remembers" is **not guaranteed**

Both outcomes measured on the same profile:

```text
(A) run1: "Remember this word: ZEBRA … ACK_ONE"
    run1 second turn: "which word?" -> ZEBRA          (same session remembers: the control)
    restart + `-s <id>` -> resumed without replay
    run2: "which word?" -> "there is no such word in this conversation"      <- forgotten
(B) the same flow on another model:
    run2: "which word?" -> ZEBRA                                            <- remembered
```

- So neither "the context carried over" nor "the context is gone" can be written down as fact;
- What can be written down is only what the spec guarantees: **no replay** (the client's screen is
  empty) and **the same session id**;
- The tab keeps its **real name** (no marker) — that the screen has no history is stated by the
  conversation's `◈ Notice` (the agent has no `session/load`);
- The bridge log and the comments in `src/acp/client.ts` say "whether it remembers is the agent's
  business; both were measured on the same profile", and README / SESSION-LIFECYCLE / ACP-MATRIX /
  SCENARIOS agree;
- The acceptance script accepts both: remembered → ✓, not remembered → recorded as a note
  consistent with the docs, not a failure. (One answer from one model is not enough to conclude
  "it never remembers".)

## ★ Fact two: switching models mid-conversation — **supported**; a failure only means that provider was down

When the next turn after a model switch reported `Connection error`, the first instinct is to
blame the agent. But that provider was entirely down at that moment while the others were fine.
A bare-ACP control experiment:

```text
[cross-provider] deepseek-official/deepseek-v4-flash -> deepseek/deepseek-v4-pro
  set_config_option: OK 4ms    currentValue updated
  turn:              OK 2151ms                      <- cross-provider switch runs fine
[cross-provider] provider-a/model-x -> provider-b/model-y
  set_config_option: OK 3ms    currentValue updated
  turn:              FAIL 15459ms -> Internal error: turn failed: Connection error.
```

- So the shape of `session/set_config_option` is fine and the switch itself is fine (same or
  different provider, before or after a turn); `Connection error` is the agent honestly reporting
  that this provider cannot be reached right now.
- Every model under that provider failed during the same window while other providers were fine —
  nothing to do with switching models.
- No workaround is needed for model switching. The TUI re-posting "the model that is already
  selected" on every mount is still short-circuited (an unnecessary agent call, worth avoiding,
  but not a correctness requirement).
- The only advice for a user: when the target provider is down, the first turn after switching
  will fail; switch back or wait.

## Windows: 9 unit tests fail ✗ (`windows.yml` now runs on demand only)

**Status**: the first real run of `.github/workflows/windows.yml` (2026-11-21, fresh repository)
failed **10 of 402 unit tests**. Two were **real product defects** and were fixed on the spot:

- `findExecutable` decided "is this a path?" by looking for `/` → a Windows path,
  `C:\…\node.exe`, contains none, so it was treated as a **command NAME** and looked up in PATH,
  returning `undefined` for a file that plainly exists;
- `matchesDirectory` read only `HOME` → Windows sets `USERPROFILE`, so `~` never expanded.

**The remaining 9 are still real defects**, not test problems:

| Failing test | What it means |
|---|---|
| `/cd move` ×2 | moving the working directory does not take effect on Windows |
| the `!command` shell ×2 + the shell list ×2 | cursor paging and byte handling break there |
| `skill attachment` | the attachment path |
| `workspace` ×2 | resolving a session's directory |

**Why the trigger is manual for now**: a job that is red on every push leaves `main` permanently
red, and **a permanently red workflow is one nobody reads** — so a genuine regression later slips
through unnoticed. The fix is to work the list down; **the commit that turns it green puts `push`
and `pull_request` back**.

Run it by hand: `gh workflow run windows.yml`.

## TODO (pending fix): dsh's tool cards show `{` instead of a title

Reported from `~/projects/webapp` with `oc-acp-client -- dsh --profile <profile>` (a profile running the
the plugin, not the built-in `--profile acp`). The transcript shows `$ {` for
shell cards and `" {` for another kind — the title collapses to the first character of a JSON
object.

Hypothesis (to verify, not yet measured): dsh's `tool_call` frame carries no usable
`title`/`name`, and its `rawInput` is an object whose JSON text starts with `{`; our name fallback
chain (`update['name']` → title → kind → `'tool'`) ends up on a value that stringifies to `{`, or
the TUI's shell row takes `input.command` from an object. Measure with
`OPENCODE_ACP_CLIENT_TRACE=1` before changing anything.
