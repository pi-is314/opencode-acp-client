# AGENTS — the entry point for developing opencode-acp-client

> 中文版：[AGENTS.zh.md](AGENTS.zh.md)

> **This file = the entry point**: what this project is, where its boundaries are, which facts have
> already been verified, and how to verify them.
> **This file wins on the facts**; protocol details live in [docs/PROTOCOL.md](docs/PROTOCOL.md),
> [docs/ACP-MATRIX.md](docs/ACP-MATRIX.md), [docs/COMPAT-OPENCODE.md](docs/COMPAT-OPENCODE.md).

---

## 0. Thirty-second orientation

| | |
|---|---|
| **What it is** | an **ACP client**, whose **interface is opencode v2's TUI** |
| **How you use it** | `opencode-acp-client -- <any ACP agent command>`: one command starts the TUI + the adapter layer (`oc-acp-client` is the short command alias) |
| **Direction** | the **reverse** of projects that "treat opencode as the agent": **borrow opencode v2's TUI as the interface and use it to consume any ACP agent** |
| **Bound to no agent** | anything that speaks ACP over stdio works; which ones have actually been driven is in the README's "Connecting an agent" |
| **Protocol surface** | **outward = ACP** (the product's protocol surface); **inward, opencode v2 `/api/*` + SSE = the UI adapter layer (an implementation detail)** |
| **Outward identity** | community-maintained, not affiliated with opencode |


> ★ **This repository starts from a single commit.** The older history lives in the old working
> directory, which is frozen (`pre-commit` / `pre-push` refuse to write) and exists to be read.

---

## 1. Reading order

| # | Document | Why |
|---|---|---|
| 1 | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | the process model + one turn end to end (**why the HTTP response is a placeholder**, why every open part must be closed) |
| 2 | [docs/PROTOCOL.md](docs/PROTOCOL.md) | the opencode v2 surface we implement + the **v2 event vocabulary** (a wrong event name or shape = renders nothing, silently). ★ **the authority is the published spec**: <https://opencode.ai/v2/openapi.json> (OpenAPI 3.1.0) |
| 3 | [docs/ACP-MATRIX.md](docs/ACP-MATRIX.md) | ★ **the capability matrix**: which ACP methods we advertise/implement (13+11+1), the 14 variants of `session/update`, **what functionality is lost when an agent lacks a capability**, and the opencode v2 surfaces that **cannot be aligned with ACP** (based on the ACP v1.25.0 schema, not the overview page) |
| 3.5 | [docs/ACP-CLIENT-OBLIGATIONS.md](docs/ACP-CLIENT-OBLIGATIONS.md) | ★ **the normative "MUST"s, one row each**: the quoted requirement → what this client does → the file that does it. Read this when you change anything on the ACP side, so a `MUST` is answered rather than missed |
| 4 | [docs/COMPAT-OPENCODE.md](docs/COMPAT-OPENCODE.md) | ★ **the opencode v2 version policy** (`>=2.0.0`), the versions verified so far, and the mechanism that "runs the whole gate automatically whenever upstream publishes a new release" |
| 5 | [docs/KNOWN-ISSUES.md](docs/KNOWN-ISSUES.md) | what is **still open** — unresolved problems and known limits (fixed ones are not recorded in this repository) |
| 6 | [docs/ACP-COMPAT.md](docs/ACP-COMPAT.md) | Runtime capability degradation and opencode v2 TUI surfaces with no ACP counterpart (**not** per-agent measurements) |
| 6.5 | [docs/AGENT-CAPABILITIES.md](docs/AGENT-CAPABILITIES.md) | ★ **per-agent capability measurements**: the `initialize` reply from each agent, and what each gap costs you in this project (e.g. dsh's built-in `acp` has no `loadSession` → resume works but shows no history, keeps the real name, and adds a `◈ Notice`) |
| 7 | [docs/SCENARIOS.md](docs/SCENARIOS.md) | ★ **the fake-agent scenario matrix**: what it can simulate, what asserts each behaviour, what renders on screen, and what cannot |
| 8 | [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | ★ **development notes**: server-only mode (`--no-tui`), how to watch a run, and the traps to know before touching the bridge |
| 9 | [docs/UPSTREAM-TUI-TESTS.md](docs/UPSTREAM-TUI-TESTS.md) | ★ **the official TUI test → bridge contract mapping, plus the per-release check pass** (start here for a new upstream release) |
| 10 | [docs/SESSION-LIFECYCLE.md](docs/SESSION-LIFECYCLE.md) | ★ **The whole session machinery**: dual ids and the map, the three resume paths, `-c`/`--session`/adoption, ordering and the epilogue, five timing traps (each tied to a measured failure) |
| 11 | [docs/E2E-PITFALLS.md](docs/E2E-PITFALLS.md) | ★★ **pitfalls when writing e2e scripts**: pinned ports, waiting for durations, asserting on UI wording, cleanup killing other runs, modal dialogs — **each one has already cost a whole gate run**. Read before editing `scripts/e2e-*.sh` |
| 12 | [docs/ROADMAP.md](docs/ROADMAP.md) | ★ **known work deliberately not in this version** (desktop, ACP v2, a resident bridge), each with **why it is deferred** — read this before starting any of them instead of re-researching |
| — | Source | `src/index.ts` (CLI / single-entry lifecycle) → `src/server.ts` (HTTP/SSE + session projection, **the heaviest file**) → `src/acp/client.ts` (**the ACP protocol implementation**) → `src/translate/events.ts` (the translation layer) |

**Protocol text**: <https://agentclientprotocol.com/protocol/v1/overview> (**append `.md` for plain text**; the index is <https://agentclientprotocol.com/llms.txt>);
the stable ACP schema: `https://github.com/agentclientprotocol/agent-client-protocol/releases/download/schema-v1.25.0/schema.json`.

---

## 2. Non-negotiables (breaking one is a bug)

1. **Only advertise capabilities you can honour.** `clientCapabilities` in `initialize` is `CLIENT_CAPABILITIES`
   (`src/acp/capabilities.ts`) = **`{ elicitation: { form: {} }, _meta: { terminal_output: true } }`** — exactly these, each with a complete path (forms via `/api/session/:id/form`, `terminal_output` via `toolOutput()`, see rule 7);
   `elicitation.url`, `fs/*`, `terminal/*`, `session.notices`, `session.compaction` are all **deliberately not advertised**
   (the reason for each is written above that constant). **Announce it only once it is implemented**; advertising without an
   implementation = the agent really calls it and we cannot answer.
   Guard test: `tests/capabilities.test.ts`. (ACP text: any capability omitted from `initialize` is treated as **UNSUPPORTED**.)
2. **Every reverse request must get an explicit answer.** agent → our requests (`session/request_permission`, `fs/*`, `terminal/*`,
   `elicitation/create`) **must be answered with a JSON-RPC error / `cancelled` even if we do not take them**; silence = **the agent hangs
   forever** (there is no timeout on the protocol side).
   Current site: `onRequest` in `src/acp/client.ts`.
3. **Never degrade silently.** Unknown HTTP route → log `[bridge] unhandled route:` and answer a well-shaped
   empty envelope (**not** 404 ✗; only an unknown **session GET sub-route** is a 404, and an unknown **session POST
   verb** answers 204 ✓); unknown `session/update` → log it;
   never attempt an unadvertised capability. **Prefer a noisy truth to a quiet guess** (the README's "Design rules", verbatim):
   that is the only way a gap gets found instead of "rendering as blank".
4. **The two hard rules of the UI adapter** (end of [docs/PROTOCOL.md](docs/PROTOCOL.md)): `session.text.*` / `session.tool.*`
   only **edit** a row and **drop the event** when the row is missing → **`session.step.started` and `session.tool.input.started`
   must be emitted first** (they are the only row creators); **a turn must close every open part when it ends**, otherwise the spinner never stops.
5. **Route order**: `/api/session/:id/permission/:rid/reply` must be registered **before** the catch-all `/api/session/:id(/.*)`
   (see the comment in `src/server.ts`), otherwise it is swallowed into a 204 and the **permission dialog hangs forever**.

6. **Every change to the ACP face is checked against the spec first.** The spec is the
   authority, not our habits and not another project's survey: bring the method inventory
   (`/tmp/acp-v1-methods.md` once fetched — otherwise re-derive it from the release's
   `meta.json`), the stable `schema.json`, and `docs/ACP-MATRIX.md`. If the spec has no
   answer, **stop and raise it** rather than inventing a method or a payload shape; a
   deliberate deviation is allowed only when it is written into `docs/ACP-MATRIX.md` with
   its reason and its spec citation, the way `scripts/check-openapi.py`'s ALLOWED table
   does for the opencode v2 surface. Unstable methods (`schema.unstable.json`: `session/fork`,
   `providers/*`, `nes/*`, `session/set_model`) exist, and may be used **only** behind the
   capability the spec gates them on — `session/set_model` was once sent unconditionally
   here, which was a deviation, and it was removed with the change that introduced it.
   ★ Read the source of the revision that is actually installed (`git show <tag>:<path>`),
   not whatever the local checkout happens to be on: a fix "verified" against a different
   revision is how a day gets spent on the wrong file (v2.0.28 vs a detached HEAD).

7. ★★ **When an ACP behaviour is unclear, align with Zed.** Zed proposed ACP (`../zed`) and agents are
   in practice debugged **against Zed**, so what Zed reads and announces is the working standard.
   Entry points: `crates/agent_servers/src/acp/v1.rs` (`client_capabilities_for_agent` — what it
   announces, which `_meta` keys it sets) and `crates/agent_ui/src/conversation_view/thread_view.rs`
   (how it picks a card — e.g. `matches!(tool_call.kind(), ToolKind::Execute)` for the terminal card).
   **Order of trust**: the ACP spec → Zed's implementation → an agent's observed behaviour; record the
   conclusion in [docs/ACP-MATRIX.md](docs/ACP-MATRIX.md).
   ★ Example already followed: `_meta.terminal_output` — Zed announces `("terminal_output", true)`,
   the agent switches dialect on it, and announcing it here is what lets a `!command` card carry
   real output instead of a `{formatted_output, exit_code}` JSON record.

8. ★★ **Any TUI behaviour is verified by us, in tmux — never handed to the owner to try.** This repo already has
   `scripts/e2e-real-tui.sh` (real opencode v2 TUI, tmux, screen assertions); whatever it can cover **must** be
   covered by it, and whatever it cannot gets a new `MODE=` rather than a manual instruction. **"I changed the
   code" is not "it renders on screen"** — the two are separated by a rendering path, and only a captured pane
   proves the second.
   ★ Three mistakes already made; copy the working form instead of repeating them:
   - **Launch the TUI by absolute path through a login shell**:
     `tmux new-session -d -s rc "cd $W && zsh -lic 'cd $W && $OC --server http://127.0.0.1:$PORT'"`
     (`$OC=/Users/.../.opencode/bin/opencode`). A bare `opencode` in tmux may have **no PATH and exit immediately**,
     after which `tmux capture-pane` answers `can't find pane` — that looks like a blank screen but is really a
     broken launch.
   - **Before using `--session` to open an old session for acceptance, confirm it really reached a session
     route**: it was measured failing to enter the session at all (the client sending no business request),
     and `scripts/e2e-epilogue.sh` later pinned down why — it depends on how the bridge answers. With an id
     the bridge does not know (or a 404) the TUI stays on its welcome screen; with a **known** id the bridge
     log shows `GET /api/session/<id>` + `/message`, so the session route is live. The criterion is therefore
     **a `/message` read in the log**, not whether the command line used `--session` (that is what the script
     waits for). To open an existing session without betting on it, use the proven **`Ctrl+X` then `L`**
     (session list), or follow an existing `--server` + interaction pattern.
   - **Assert on the screen, never on JSON**: a row present in `/api/session/:id/message` does **not** mean the TUI
     renders it — that is exactly how the `!command` card was "fixed" while remaining absent from history.
     The evidence is the text from `tmux capture-pane`.
   ★ Only when something genuinely cannot be reproduced in the real TUI (real model quota, a private local config)
   may the owner be asked — and then say what was tried, where it stalled, and what to look at.

---

## 3. Architecture at a glance

```
opencode v2 TUI ──HTTP + SSE(/api/*)──▶ this process ──ACP stdio (JSON-RPC)──▶ one ACP connection per agent program (sessions multiplexed)
             (UI adapter layer: implementation detail)   (translation layer + session projection)   (the protocol surface: the real thing)
```

| File | Responsibility |
|---|---|
| `src/index.ts` | CLI parsing, single-entry lifecycle (starts the TUI by default, `--no-tui` degrades), agent command preflight, opencode v2 binary resolution/version gate, signal and exit cleanup, the ready line |
| `src/server.ts` | routes, session verbs, prompt/turn lifecycle, session rename/title, the permission queue |
| `src/sse.ts` | `/api/event`: fan-out, the `server.connected` handshake, `Last-Event-ID` ring replay, `: keepalive` every 15s |
| `src/state.ts` | sessions / messages / parts (in memory) |
| `src/contract.ts` | the opencode v2 surface we implement (**observed, not invented**; inferences are marked `INFERRED`) |
| `src/acp/client.ts` | spawn, JSON-RPC correlation and timeouts, answering reverse requests |
| `src/acp/capabilities.ts` | negotiation + degradation (`effectiveCapabilities` / `filterPromptBlocks` / `clientCallbackSupport`) |
| `src/translate/events.ts` | ACP `session/update` → opencode v2 events (**the most central translation layer in this repo**) |
| `src/project.ts` | internal messages → the spec's typed `Session.Message.Info` (the history/reload path depends on it) |
| `src/acp-replay.ts` | `session/load` replay → the `HistoryEntry[]` the client can render |
| `src/opencode-bin.ts` | opencode v2 binary resolution (`$OPENCODE_BIN` → PATH) + the major-version gate (`MIN_MAJOR_VERSION = 2`) |

**One ACP connection per agent program, spawned lazily** (spawned only on the first prompt), with sessions multiplexed over it: each session keeps its own catalog, translator and history, while the process is shared. The cost: an agent crash takes every session on that connection.

---

## 4. Commands and verification

```bash
pnpm install
pnpm build        # tsc -p tsconfig.json && chmod +x dist/index.js   ← it is tsc, not tsdown
pnpm typecheck    # tsc --noEmit
pnpm test         # vitest run
pnpm verify       # ★ the master gate = typecheck + unit tests + doc links + spec conformance + smoke/entry/real TUI (including cancel)
pnpm verify:version 2.0.27  # the same gate against a given opencode v2 release (npm-installed into a temp prefix,
                  #   without touching your ~/.opencode; latest-v2 = the newest >=2.0.0 on npm)
pnpm e2e          # = bash scripts/e2e-smoke.sh  fake agent + real HTTP, 20 scenarios
pnpm e2e:entry    # = bash scripts/e2e-entry.sh  the single entry point: start the TUI, exit code, zero leftovers
pnpm e2e:todo:win # = node scripts/e2e-todo-windows.mjs  ★ MODE=todo for Windows (no tmux there)
                  #   node-pty stands in for tmux; asserts the v2.1 todo sidebar on the
                  #   captured pane. Skips on v2.0 like the bash mode; no-ops off Windows.
pnpm e2e:protocol # = node scripts/e2e-protocol.mjs  ★ the ONLY end-to-end check that runs on Windows
                  #   (no bash, no tmux): ready line → session → turn → real catalog, not the
                  #   acp/default placeholder → model switch → interrupt shape
pnpm e2e:agent    # = bash scripts/e2e-real-agent.sh  a real agent (AGENT=<command> is mandatory; no prompt by default)
pnpm e2e:tui      # = bash scripts/e2e-real-tui.sh    the real opencode v2 TUI (tmux): assert against the screen + reload history
                  #   the MODE=cancel mode exercises the cancel gesture (it hangs the agent on purpose; the real Escape must be pressed twice)
                  #   MODE=shell-history proves the !command card survives a reload (screen assertion)
                  #   MODE=patrol drives every slash command the TUI offers once (alive + no
                  #   UnexpectedStatus + a per-command snapshot)
                  #   MODE=cd proves /cd moves the session end to end: the Moved row, the footer,
                  #   !pwd and the agent's own next answer all follow, and the re-load's replay
                  #   does not render twice
                  #   MODE=restore-turn proves a tool call on a restarted-then-restored session reaches the screen
                  #   MODE=restore-tab proves a restart-then-reopen-from-the-tab-list restore (the owner's real path)
                  #   MODE=unsupported-verb proves verbs we cannot perform (/compact, /btw, /undo) fail with declared statuses
pnpm e2e:epilogue # = bash scripts/e2e-epilogue.sh  the Continue line the TUI prints on exit (real TUI + tmux, 4 cases)
                  #   quiet resume / intent outranks another tab's "viewed" / only "viewed" / nothing at all
pnpm e2e:dsh-acp # = bash scripts/e2e-dsh-acp.sh  ★ full acceptance against a real agent (default `dsh --profile acp`; **spends tokens**)
                  #   TUI up / a real turn / tool card / !command / /model / /compact + /btw / the Continue line /
                  #   `-s` resume (no replay). Archives the agent's test sessions; deliberately not in the gate.
```

- **Test state (measured on this machine): 29 files / 432 passed / ★ 0 skipped.**
  The README's status table is **hand-written**, so remember to sync it when you change the tests.
- ★ **Do not introduce skips again.** The 6 skips that once existed were all in `tests/server.test.ts`: under vitest, reading SSE
  through **`fetch` buffers**, so the read never returns. **The fix is to switch to `node:http`** (a real socket), not to mark them skipped ✗ —
  after the switch all 6 pass, and it **immediately exposed two real bugs**: ① a subscription is established asynchronously, so `openStream`
  followed by an immediate action drops the earliest events (now `await reader.ready`); ② a read that subscribes "after the fact"
  **can never see earlier events** (the hub's ring buffer does not replay to a new subscriber).
  ⟹ Lesson: **skips hide bugs, and they look like "environment problems"**.
- **Route shapes have unit tests too** (`tests/routes.test.ts`): `ServerInfo`'s required fields, the `location` envelope being only `{directory}`,
  a session's `active` keys and values, typed messages, the two health-probe spellings — exactly the places the real TUI once caught.
  The exhaustive **per-schema** check lives in `scripts/check-openapi.py` (52 probes, needs python3+jsonschema+network) and is run by `pnpm verify`.
- ⚠️ In `scripts/e2e-smoke.sh`, `[ -f dist/index.js ] || tsc …`: **if `dist` already exists it is not rebuilt**,
  and `dist/` may still hold stale artefacts from source files that have since been deleted → **run `pnpm build` before the e2e**
  (`pnpm e2e` does not do this).
- ★ **`scripts/e2e-agent-matrix.sh`: real agents end to end** ([claude-acp](https://github.com/agentclientprotocol/claude-agent-acp), [codex-acp](https://github.com/agentclientprotocol/codex-acp), `opencode acp`,
  `dsh --profile acp`, `qwen --acp`, and gemini's `--acp`). Each runs one full turn on a REAL terminal,
  asserted on the SCREEN: boots, footer shows a real model, the turn completes, the
  reply — or the agent's own error — renders, and the exit line is ours. An agent's
  own credentials/config produce **BLOCKED** (not our failure): carrying the error
  faithfully is the job. Each agent's quirk is documented in the script (codex's
  catalog rejects `"effort": "max"`; `opencode acp` has no provider credentials).
- **`scripts/e2e-real-agent.sh` is the only script that touches a real agent**: you **must** name the agent to verify with `AGENT=<command>`
  (this repo presets no agent); it **sends no prompt by default (spends no tokens)**, and only `PROMPT=1` sends one → **that spends tokens, so ask the user first**.
  What it asserts is "the real model list has arrived", not "an endpoint answered" — before any session has reached ACP, `/api/model` answers
  with the **placeholder model** `acp/default`, and merely counting entries mistakes the placeholder for success (a trap we have hit ✗).
- The tests **do not need a real opencode v2**: the fake agent is `tests/fake-acp-agent.mjs` (the `FAKE_ACP_*` switches), and the fake TUI is
  `tests/fake-opencode-tui.mjs` (`FAKE_TUI_EXIT` / `FAKE_TUI_SLEEP_MS`; answering `--version` is enough to pass the version gate).
  **If you need a new agent behaviour, extend them — do not mock inside the test body.**
- ★ **Write edge cases as raw JSON, not object literals** (`tests/raw-updates.test.ts`). A literal cannot
  express "the key is absent", and ACP gives absence and `null` different meanings (only
  `rawInput`/`rawOutput` are declared equivalent; elsewhere an omitted field means unchanged). Zed
  models it as `MaybeUndefined::{Undefined, Null, Value}` (`acp/terminal_updates.rs`,
  `patch_preserves_omission_and_null`) — do the same and paste the JSON an agent would send.
- ★ **Every frame is validated against the official schema** (`tests/acp-schema.test.ts`). Behavioural
  tests prove the bridge does what it intends; they say nothing about whether what it sends is legal —
  a misspelled field (schema wants `configId`, we send `configOptions`) passes every behavioural
  assertion and fails at the first real agent. `session/set_model` cost a day that way. The schema is
  the one the ACP project publishes (`agentclientprotocol/typescript-sdk`, `schema/v1/schema.json`),
  **vendored into `tests/fixtures/acp-schema/`** so the suite needs no network; the `meta.v1.json`
  beside it lists every method of the protocol, which also lets us assert that we only name methods
  that exist.
- Before committing: `pnpm typecheck && pnpm test`; if you touched the HTTP/ACP surface, run `pnpm verify` as well (or at least `bash scripts/e2e-smoke.sh`).
- ★ **Match the gate to the change's size — never run it mechanically**:
  - **Small changes** (copy, comments, a single assertion, minor script fixes):
    `pnpm typecheck && pnpm test` is enough — **do NOT run the full `pnpm verify`**;
    it takes a quarter hour and spending that on three lines is waste. **Ask the
    owner before running the full gate.**
  - **Large changes** (protocol surface, translator, the CLI PARSER, route
  behaviour, a new MODE): **run the full `pnpm verify` directly** — no need to ask.
  The CLI parser counts as large in particular: it is the entry to every path, and
  one lexical misclassification hides a branch from the whole e2e suite (a native
  subcommand's arguments were claimed as the directory, and every e2e script starts with
  `--no-tui` so never hit it).
- ★ **Run the full gate inside a SUBAGENT, in the background**: never in the foreground of the main session, and not merely
  `&`-ed from it either — `pnpm verify` takes ~15 minutes and blocks interaction.
  Have a subagent run `bash scripts/verify.sh > /tmp/verify.log 2>&1` and report
  the tail plus the exit code; the main session only reads the verdict.
  - When unsure, lean towards asking rather than guessing.
- **If you changed the shape of the HTTP surface, run the spec conformance check**: `pnpm verify` runs it; to run it on its own use
  `python3 scripts/check-openapi.py --spec .cache/openapi.json`. Its `ALLOWED` table is the register of "we deliberately differ",
  and every entry states why. Current baseline: **32 pass / 20 notes, each informed / 0 fail** (52 probes).
  Explicitly registered examples: the `location` envelope is only `{directory}`, `parts` coexists with the typed message fields,
  both the `/api/form` and `/api/form/request` spellings are served, and both `/api/health` and `/api/info` are served (the client's health-probe endpoint moved).
- **Do not let a unit test depend on a real opencode v2 install**: the version-gate path just needs `OPENCODE_BIN=<path>` pointing at a fake binary
  (that is what `tests/opencode-bin.test.ts` does).

---

## 5. Verified facts and pitfalls

### 5.1 Hard facts on the ACP and opencode v2 sides

- **`session/update` has 14 variants** (ACP v1.25.0 schema): we **translate 9**, `plan`/`available_commands_update`/
  `current_mode_update` are **logged only**, and `notice`/`compaction_update`/`compaction_summary_chunk` **never arrive at all**
  (we do not advertise `session.notices` / `session.compaction`, and opencode v2 has no surface to show them either).
- **Cancellation semantics**: `POST /api/session/:id/interrupt` (the older `/abort` is served too) answers
  `200 {interrupted: boolean}`; on cancel ① unfinished tools are closed into a terminal state ② pending permissions are answered `cancelled`
  ③ pending forms are settled as `cancel`. E2E scenario 7 asserts that the agent **really received** `cancelled`.
- **A cancelled turn emits `session.execution.interrupted`** (not `succeeded`), and the decision **follows our own cancellation intent**
  (`record.interruptRequested`: set by `/abort`, cleared by `beginTurn`), **not just the agent's stop reason** — a cancelled agent
  may still answer `end_turn`.
- **The response to `session/set_config_option` carries the complete config state** (so we store it and do not merge),
  and `config_option_update` drives the model picker → `session.model.selected`.
- **There is no `cancelled` tool status on the ACP wire** (only pending / in_progress / completed / failed), but agents do send it;
  it must be treated as a terminal state, otherwise **the spinner never stops**.
- ★ **The permission dialog is verified on the real TUI**: it renders as a **footer**
  (`△ Permission required` + `⚙ Call tool …` + `Allow once  Reject`, with `⇆ select  enter confirm`
  underneath), driven by **left/right to choose, enter to confirm, esc to reject**; the TUI then
  `POST /api/session/:id/permission/:rid/reply`, the dialog disappears and `/api/permission/request`
  goes empty. Concurrent requests put a `!` attention marker on the tab.
  ⟹ The footer sits at the very **bottom** of the screen: capturing only the first 20 lines makes a
  working permission dialog look like it never appeared.
- ★ **The transcript list is newest-first**: `GET /api/session/:id/message` reverses for the client
  (the client reverses back), so **flattening that list is not the order things happened** — to read
  interleaving, look at a single assistant message's own `content[]`.
- ★ **`session/prompt` has no clock by default**: it may run as long as it needs; other control
  requests still time out at **120 seconds**. History: a review with 20+ tool calls was killed
  silently after two minutes, so a 30-minute total was added; real long tasks were then killed twice
  by that same 30-minute **total** (the agent still running, the TUI printing `timed out waiting for
  session/prompt`, the agent's prompt still active). ACP has no server-side prompt timeout — the
  TUI's Esc/interrupt is the user's stop button. A positive `OPENCODE_ACP_CLIENT_PROMPT_TIMEOUT_MS`
  restores the clock. ✓ Verified: `tests/prompt-timeout.test.ts`.
  ★ **The timeout argument must be used where it applies**: `request()`'s `setTimeout` must use the
  argument passed in, not `this.timeoutMs`. And **assert at the layer the behaviour lives in** — an
  HTTP-level probe is defeated by unrelated causes (a turn that never settles, `agent exited`) and
  proves nothing; an AcpClient unit test does.
- ★★ **After we declare a turn dead, the agent's later tool calls render as "static history"** (no
  spinner, but the result still appears) — measured on a real session: **6 of 24 tool calls** started
  after the message was marked completed (earliest +1.7s, latest **+180s**), the first 18 before it.
  So "the tool stopped spinning" and "the task silently stopped" can share one root cause. Line up
  the timeline first.
- ✓ **A tool's time lives in `content[].time`, not `state.time`** (`src/project.ts:130`):
  `{created, ran, completed}` — `created`/`ran` are the start, `completed` the end; the internal part
  is where `state.time.{start,end}` lives. ⚠️ Checking the wrong field once produced the conclusion
  "the projection lost the time": `entry.state.time` was `None`, but the data was all there under
  another key, and the UI reads `content[].time`. ⟹ **Confirm you are querying the field you think
  you are before declaring it missing.**
- **`/api/model` answers the placeholder model `acp/default` before any session has reached ACP**: when verifying a real agent,
  assert that "a model with a **provider other than the `acp` placeholder** has appeared".
- **The v2 event vocabulary**: the spinner stops on `session.execution.succeeded|failed|interrupted`, **not `session.idle`**
  (the client's store does not handle `session.idle`).
- **Environment variables**: `OPENCODE_BIN` selects the client binary (**there is no `--opencode` flag**);
  the six debug switches are all `OPENCODE_ACP_CLIENT_*` — `_TRACE`, `_DUMP`,
  `_MESSAGE_PROBE`, `_PROMPT_TIMEOUT_MS`, `_RUN`, `_RECORD_FRAMES` — with **no legacy aliases**.
  ★ **The bridge writes exactly one file**: the **session-id map** at
  `~/.opencode-acp-client/sessions.json` (relocate with `OPENCODE_ACP_CLIENT_SESSION_MAP`) — it
  holds the id the client was shown, the agent's own id behind it, the directory, an optional agent title, and
  **the agent command that created it** (`agent: {command, args}`, e.g. `{opencode, [acp]}` — a restored tab is
  REATTACHED with that agent, because ACP has no notion of "this session belongs to that agent" and handing the id
  to the wrong one only yields an empty tab). Entries WITHOUT it are refused (404): their owner is unknown, and
  guessing the launching agent is exactly how a dsh id ends up in opencode v2 as an empty tab; the log says to delete
  the entry (or the whole map),
  and never message content or credentials. **Why a file at all**: ACP does not let a client name a new
  session (`session/new` has no id field, and `_meta.sessionId` is not honoured — measured), so
  the id a client remembers and the id the agent answers to are necessarily different, and
  without the pair a restored tab can only open an empty new session. `_TITLE_REQUESTS` remains
  deleted: ACP has no client-side way to set a title.
  ★ **One direction only, visible id → agent id.** It used to also store the agent id mapped to
  itself, and nothing reads that: every id the client requests is the `ses_…` alias the bridge
  showed it (measured — the TUI asks for `ses_ec3718af…` and `ses_acp_…`, never a bare UUID), and
  the only reverse lookup, `visibleIdFor`, requires `visibleId.startsWith('ses_')`, so a
  self-mapping could never match. The cost was real: self-mappings were **79 of 153 rows (52%)** in
  the owner's file, and `flush()` sorts by `updatedAt` and truncates at `MAX_ENTRIES = 500`, so the
  dead weight could crowd out real mappings. Removed.
  Regression check: `grep -rn -E 'ACP_BRIDGE_|ACPB_|ACP_OPENCODE_BRIDGE_|DSH_BRIDGE_' src tests scripts` (must be empty).
- ★ **A failure can be silent even when the request fails.** Two paths existed: ① after the turn
  began, we set `error` + `finish:'error'` on the message and the TUI renders it; ② **before** the
  turn began (`ensureAgent`: spawn / `initialize` / `session/new`), the `await` sat outside the
  prompt's try, the request rejected, no message was produced, and the screen kept the user's row
  followed by nothing — no spinner, no error, no end. **② is handled**: the prompt path
  catches it, opens a turn and closes it with the failure (`session.step.failed` plus an assistant
  row carrying `error`), in the same HTTP shape as a normal turn. The lesson stands: *"the request
  failed" and "the user saw a failure" are two different things* — every new throwing `await`
  should be asked what is on screen when it throws.

### 5.2 Pitfalls (all worth keeping)

1. ★ **The client's store does not handle `session.updated`**: the title/rename events we used to emit were **all silently no-ops** ✗.
   What actually works is **`session.renamed`** `{sessionID, title}`. Whenever "we emitted an event but the UI did not react", go and grep the
   event name in that store — **do not guess**.
2. ★ **Our own fake agent used to treat a *response* as a *request*** ✗ — so **every "callback round trip" had in fact never closed**.
   Now `onMessage` first decides "no method, has an id = a response to me", and the e2e asserts that the **agent really received** it.
   ⟹ Lesson: **"we emitted the event" and "the peer received it" are two different things, and each must be asserted separately**.
3. **`session.created` must carry `sessionID`**: the client's store reads `event.data.sessionID`, and sending only `{session}` makes it
   sync a session called `undefined` (the log really does show `GET /api/session/undefined`).
4. ★ **Reading a transcript takes two steps**: `GET /api/session/:id/message` returns only the **message infos**, and the **parts are in `/message/:id`**.
   Reading only the list concludes "the model said nothing" (we were fooled once ✗). And the client reads **only the list** when it reloads
   ⟹ the list items must be the spec's typed `Session.Message.Info` (see pitfall 6).
5. ★ **Stream-only without store always leaves history empty**: the prompt text used to be emitted as an event only and never stored in state,
   so that user message in history had no part and projected as `text: ''` (the user's row rendered blank). The fix: `state.upsertPart(...)` in the same place.
6. ★ **The projection layer must follow the spec** (`src/project.ts`): `/message` and `/message/:id` answer
   `Session.Message.Info` (user carries `text`; assistant carries `agent`/`model`/`content[text|reasoning|tool]`),
   history ids gain the `^msg_` prefix; `parts`/`role`/`sessionID` are kept as a **registered superset**.
7. ★ **Real-TUI acceptance must assert against the screen, and asserting "there is text" is not enough**: if the fake agent's reply is the
   same string as the prompt, a single echo can fool the user row and the assistant row at once ✗ — set `FAKE_ACP_REPLY` to a different string,
   and require the user row / thought block / **tool card + input** / reply / agent/model footer **all** to appear. Captured screens are stored in `.artifacts/`.
8. ★ **A form's starting page is a race — read the prompt line, do not count key presses**: the TUI shows one
   screen per field plus a summary, and the prompt line says which (`enter confirm` / `enter toggle` /
   `enter submit`). **The Enter that submits the prompt can land after the form appears** and push the form
   one step along → the same script starts on `Strategy` one run and on the summary screen the next.
   "Count Tabs from an assumed start" is therefore right half the time, which looks like "same setup,
   different result". Fix: **read the prompt line to normalise position**, then answer, then walk to
   `enter submit` (`MODE=form` in `scripts/e2e-real-tui.sh`, asserted down to "the TUI really POSTed the
   reply + the form closed + nothing is left pending"). ⟹ **Drive the UI by state, not by count.**
9. ★ **The cancel gesture is "press Escape twice"** (within 5 seconds; the first press only arms it, and the footer goes from
   `esc interrupt` to `esc again to interrupt`); it sends `POST /api/session/:id/interrupt?resume=true` and expects
   **`200 {interrupted: boolean}`**. We used to answer **204** → the real client logged an
   `unhandled rejection: UnexpectedStatus: 204` on every cancel ✗.
10. ★ **A false premise can make a test "prove" a completely wrong conclusion**: our cancel script used not to hang the agent by default,
   so the turn ended instantly → the cancel command was disabled, and it "proved" that "Esc sends nothing".
11. **A broken agent side looks like a client bug**: when a certain agent's plugin failed to import, it might write the answer into the
    session title only and **never send `agent_message_chunk`** — on screen that is "the model said nothing". When something "says nothing",
    first use `OPENCODE_ACP_CLIENT_TRACE=1` to see whether the bridge received a chunk, and **only then** suspect the client.
12. ★ **When you change a function's signature, go back and change its body**: `request()` gained a `timeoutMs`
    argument while `setTimeout` still used `this.timeoutMs` → the caller's timeout was **silently ignored**,
    and the "fix" looked like it worked. Verifying at the wrong layer hides it: two HTTP-level probes failed
    for unrelated reasons (a turn that never settled, `agent exited`) and proved nothing, while asserting
    directly on `AcpClient` exposed it at once. ⟹ **Assert at the layer the behaviour lives in.**
13. **Different agents differ a lot in startup speed** (one measured took ~8s to finish `session/new`), so `waitForCatalog`'s 12s is a **real**
    deadline (`Promise.race`); do not turn it back into a bare `await`.
14. ★ **Capability gating belongs in the layer that actually sends the request**: deciding at the call site
    ("look at `loadSession` and go or not") is not enough — the parsed capabilities must carry it
    (`EffectiveCapabilities` has to parse `sessionCapabilities.*`) and **`AcpClient`'s method must gate
    again**, so no new call site can bypass it. Otherwise the request is still sent to an agent that never
    advertised it (the spec says MUST NOT), and a refusal escapes the session-start path. Guard:
    `tests/capabilities.test.ts`.
15. ★ **A hand-written client file must copy the real shape**: the TUI's `tabs.json` is
    `{global:{…}, cwd:{<dir>:{tabs:[…]}}}`; writing `{<dir>:{tabs:[…]}}` makes the TUI crash on start
    (`TypeError: undefined is not an object (evaluating 'g.cwd[u.cwd]')`), which looks like "the bridge
    broke the client". ∴ When fabricating client state, **read a file the client itself wrote** first.

---

## 6. Process and environment discipline (lessons paid for in blood)

- **Terminate child processes by explicit PID / process group only**; ✗ **never `pkill -f '<name>'` to kill by name in bulk** — it kills the
  user's editor or their other sessions. The existing shape of `AcpClient.dispose()` (SIGTERM → 3s → SIGKILL) is right; keep it.
- **Do not use grep to judge what an ACP implementation supports** (vendored SDKs pollute the result) — **actually run `initialize`** and see what
  it advertises. `OPENCODE_ACP_CLIENT_DUMP=<path>` writes the raw `session/new` response to disk, and the `[acp] initialized: {…}` log line is
  the only ground truth for the capability matrix.
- Probe with a **throwaway profile / temporary directory** only; **never touch** the user's existing configuration; and probing **must not** call
- ★ **Archive the sessions a real-agent test leaves behind.** A real agent writes its
  sessions into **its own store** (dsh: `~/.dsh/sessions/<workspace>/<sid>/`) and they show up
  in its web UI — and dsh advertises **no `sessionCapabilities.delete`** (measured:
  `session/delete` hangs unanswered), so ACP cannot remove them. Therefore: ① prefer the fake
  agent whenever it can prove the point; ② when a real agent is genuinely needed, **run
  `python3 scripts/archive-test-sessions.py` when the test is over** — it MOVES (never
  deletes) test sessions into `~/.dsh/sessions-archived-bridge-tests-<ts>/` with a companion
  inventory JSON (matching the owner's own `sessions-archived-*` convention). It only takes
  test workspaces (tmp/e2e cwd) and today's empty or test-marker sessions; real sessions are
  never touched.
  verbs that really delete data.
- ★ **Always check for orphaned processes after an ad-hoc probe**:
  ```bash
  ps aux | grep -E "dist/index.js|bin/dsh --profile|fake-acp-agent"
  ```
  **`tmux kill-session` does not reap grandchildren** — kill the bridge and the
  agent it spawned survives as a `ppid=1` orphan. Backends are one-writer: an
  orphan holding a workspace lock makes every later `session/load` fail
  ("Internal error"), which LOOKS like a bridge bug while the bridge's own log
  reads perfectly healthy. This cost three debugging rounds in one day: 14
  orphans locking a workspace, then a misdiagnosis that "the epilogue rewrite
  stopped working" (the real culprit was a two-day-old bridge still serving).
  ⟹ **Step one for "resume comes up blank" or load failures.** The committed e2e
  scripts clean up after themselves; ad-hoc probes do not.
- Turn debug switches **off when you are done**: `OPENCODE_ACP_CLIENT_TRACE` writes every HTTP request and every ACP frame to the log (very loud);
  `OPENCODE_ACP_CLIENT_MESSAGE_PROBE` is the observer for the "messages disappear" bug.
- **To watch `[http]` logs you must use `--no-tui`**: in the default mode the TUI owns the terminal, so we write the logs to a file under `$TMPDIR`
  (**a single stray output line tears the TUI's rendering apart**); in server-only mode the logs go straight to stderr. stdout is always reserved
  (the ready line / the ACP wire).
- **Only one "start the TUI" process at a time**: a random port + one TUI child process; do not run two concurrently.
- Do not `pnpm link --global .`: it turns this package into a dependency of itself, rewrites `package.json`/the lockfile, and wants to purge
  `node_modules`. Use the symlink or the wrapper from [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md), "Running from a checkout".

---

## 7. External surface (who breaks when you change something)

| Who | Depends on what | State |
|---|---|---|
| **opencode v2 upstream** | we implement opencode v2's `/api/*`: the **published OpenAPI 3.1.0** (<https://opencode.ai/v2/docs/api>, machine-readable `/v2/openapi.json`) | treated as a **contract**; `pnpm verify` validates it route by route, and deliberate differences are registered in the `ALLOWED` table. Version policy in [docs/COMPAT-OPENCODE.md](docs/COMPAT-OPENCODE.md) |
| **opencode v2 clients** | point at this bridge with `--server <url>` | the interface layer; **only the TUI is verified** (screen-by-screen e2e). ★ Other clients are not recommended yet: the state roots are injected into the TUI child we spawn, and no other client can be given them, so its tabs are not isolated per agent |
| **ACP agents** | any command that speaks ACP over stdio | bound to no implementation; the list of those driven so far is in the README, and the degradation rules are in [docs/ACP-COMPAT.md](docs/ACP-COMPAT.md) |
| An old bin name a user has on PATH | a historical name | **decided: no compatibility aliases** (want compatibility? add one fallback level in your own launcher) |

---

## 8. Decided

1. ★ **No legacy aliases for the environment variables**; the binary is selected by `OPENCODE_BIN` alone, and there is **no** `--opencode` flag.
2. **bin names**: the outward primary is **`opencode-acp-client`** (package name, used in the docs); `oc-acp-client` is only the short command alias. Publish both, pointing at the same entry.
3. **Outward identity**: community-maintained, not official opencode; the direction is "borrow opencode v2's TUI to consume any ACP agent".
4. ★ **LICENSE = Apache-2.0**. Why it stands alone: the bridge links **no
   third-party source** — it launches the opencode v2 binary as a separate process and talks to its
   published HTTP API, so no other licence is inherited. Apache over MIT is decided by the
   **patent grant** (what enterprise legal reviews) and by matching the ACP ecosystem
   (claude-code-acp / codex-acp / claude-agent-acp are all Apache-2.0). The copyright line uses
   the **community form** (`Copyright 2026 opencode-acp-client contributors`), naming neither a
   person nor a company.
5. **Brand consistency**: `--help` stays English, the README stays bilingual.
6. **A symmetric product** (another TUI + the same bridge) is **another repo's** business, out of scope here.
