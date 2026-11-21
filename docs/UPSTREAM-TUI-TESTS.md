# How opencode v2 tests its TUI — and what we borrow on each release

> 中文版：[UPSTREAM-TUI-TESTS.zh.md](UPSTREAM-TUI-TESTS.zh.md)

This document exists so that a **new opencode v2 release can be checked in one pass**: what the
official suite does, which of it constrains *this* bridge, which of it is the TUI's own business,
and where the corresponding test lives here.

Everything below was read from the released tag with `git show <tag>:<path>` — not from a local
checkout, and not from documentation.

## 1. The official approach, in one screen

opencode does not primarily test its TUI by running a real terminal. It uses three layers:

| Layer | Real | Fake | What it proves |
|---|---|---|---|
| Render tests | the TUI components, mounted in an in-memory terminal via `testRender` | the API | what actually renders, key by key |
| Store/data tests | the real `data` store, session-tabs store, sync logic | `fetch` and the SSE stream | that the client's state machine consumes our events correctly |
| CLI/app e2e | a real process / real UI automation | a mock API server | end-to-end wiring |

The middle layer is the one that constrains a server, and it is the one we translate.

## 2. The official fake backend, concretely

All of it lives in **one file** at tag v2.0.28:

```text
packages/tui/test/fixture/tui-client.ts
```

It contains four things:

1. **`createEventStream()`** — a fake `/api/event`. `emit(event)` pushes a frame to every
   subscriber; `v2()` returns a `Response` whose body is a `ReadableStream`, and the first frame
   is always `{id:"evt_connected", type:"server.connected", data:{}}`. Frames emitted before a
   subscriber attaches are queued and flushed on connect. `disconnect()` closes every stream.
2. **`createFetch(override, events)`** — a drop-in `globalThis.fetch` replacement. It matches
   `url.pathname` against a long list of routes and returns literal JSON for each; the override
   callback runs first, so a test can take over any single route (that is how the reconnect test
   makes `/api/session/active` hang). Anything unmatched **throws** `unexpected request: <path>`.
3. **`createApi(fetch)`** — `OpenCode.make({baseUrl:"http://test", fetch})`, i.e. the real
   generated client bound to the fake transport.
4. Small fixtures: `directory`, `worktree`, `json()`.

Its two design decisions are the ones worth copying:

- **The contract is the request path**, not a server object. A route that is missing is a thrown
  error, so an unimplemented endpoint cannot pass silently.
- **The transport is swappable at the `fetch` boundary.** Redirecting `fetch` reaches the real
  store, the real sync logic and the real components; nothing in the client is mocked.

## 3. Why we cannot take the file as-is

`tui-client.ts` is **not importable by this repository**, for reasons that are structural rather
than stylistic:

| Obstacle | Detail |
|---|---|
| Wrong kind of fake | It replaces `fetch` *inside the client process*. Our bridge is a server; the code under test is the server, so a client-side `fetch` stub would replace the thing we are testing instead of the thing we control. |
| Build system | Official tests are `bun:test` + `@opentui/solid` `testRender` + Solid JSX. This repo is Node + Vitest, with no Solid toolchain. |
| Internal imports | It imports `@opencode/client`, `@opencode/core/session/message`, `@opencode/schema/event` and internal paths such as `../../../src/context/data` — none of which exist as a published package surface. |
| Different fixture data | Its `directory`/`worktree` are `/tmp/opencode/...`, its session ids are `session-stale`-style, and its `capabilities.persistentPty: true` is the opposite of this bridge's truth. Copying it would import the *agent's* assumptions, not ours. |
| Wrong assertion target | Its assertions are about TUI store state reached through a stub. Ours must be about **bytes the bridge really writes on a real socket** — that is the entire point of this repository's tests. |

What is genuinely borrowable is the **shape**, not the code: a single fake-backend module per
test process, an explicit route table, and a hard failure on an unmatched request.

## 4. What we have instead, and what it is called

| Official concept | Our equivalent | Where |
|---|---|---|
| `createEventStream()` — fake SSE server | a real `node:http` SSE client against the real hub, with `Last-Event-ID` support | `tests/server.test.ts` (`subscribe`/`openStream`) |
| `createFetch()` — fake HTTP server | the real bridge on a real ephemeral port, plus the real ACP fake agent over stdio | `tests/scenarios.test.ts` (`start()`) |
| fake ACP **backend** | `tests/fake-acp-agent.mjs` — a real ACP child process with `FAKE_ACP_*` switches | `tests/fake-acp-agent.mjs` |
| `testRender` component assertions | real `opencode` TUI inside `tmux`, asserted **by screen contents** | `scripts/e2e-real-tui.sh` |
| `unexpected request:` hard failure | unknown route → `[bridge] unhandled route:` log + well-formed empty envelope; the OpenAPI probe fails on a wrong shape | `src/server.ts`, `scripts/check-openapi.py` |

One deliberate difference: the official stub is **stricter** than we are. It throws on an unknown
path; our bridge must answer *something* well-formed because a real client treats a 404 as fatal
(AGENTS.md rule 3). We keep the loudness in the log and in the OpenAPI probe instead of in a
throw, and that trade is registered in `scripts/check-openapi.py`'s `ALLOWED` table.

## 5. On each new opencode v2 release: the check pass

Run this when a new opencode v2 release appears. Replace `<tag>` with the new tag.

1. **Read the released fixture, not the checkout.**
   ```bash
   git show <tag>:packages/tui/test/fixture/tui-client.ts
   ```
   Diff it against the previous tag. Three changes matter to us:
   - a **route added or removed** in the `createFetch` table → check whether this bridge serves it
     and whether `scripts/check-openapi.py` should probe it;
   - a **new default assertion** inside `createEventStream()` (the handshake shape) → the client
     now expects it on connect;
   - `capabilities` in the fake `/api/info` → tells us what the client believes the server has.

2. **List the TUI test files and look for new behaviour-level names.**
   ```bash
   git diff --stat <old-tag> <tag> -- packages/tui/test
   git show <tag>:packages/tui/test/cli/tui/data.test.tsx | grep -n '^test(\|^  test('
   ```
   A test whose name describes **client-server** behaviour (reconnect, resync, pending state,
   pagination, ordering, deletion) is a candidate contract. A test about layout, animation, mouse
   handling, themes or component internals is not.

3. **Translate each candidate into one of two shapes.**
   - *Bridge contract* → a Vitest case in `tests/server.test.ts` (SSE/HTTP lifecycle) or
     `tests/scenarios.test.ts` (a scenario through the fake agent).
   - *Screen behaviour* → a `MODE=` branch in `scripts/e2e-real-tui.sh`, asserted against the
     captured pane, with the pane saved under `.artifacts/`.

4. **Extend the fake agent rather than mocking.** If the new contract needs an agent behaviour,
   add a `FAKE_ACP_*` switch to `tests/fake-acp-agent.mjs`; the suite must not mock ACP.

5. **Register deviations.** If the new release constrains a shape we deliberately answer
   differently, add the reason to `scripts/check-openapi.py`'s `ALLOWED` table and to
   `docs/ACP-MATRIX.md` if the ACP side is involved.

6. **Run the gate, then the version pin.**
   ```bash
   pnpm verify
   pnpm verify:version <tag>
   ```

## 6. The mapping table (keep this current)

Column meaning:

- **Upstream** — `<path>:<line> <test name>`, read from the released tag. `test(` line numbers move
  between releases; use them to *find* the test, then match on the **name**.
- **Contract for this bridge** — what the bridge must do for that test to pass against a real
  server. If a new upstream test implies something here that we do not do, that is the finding.
- **Ours** — the file and the case that checks it here. `—` means deliberately not migrated.
- **Status** — `✓` covered, `~` partially covered, `✗` known gap, `n/a` not a bridge concern.

### 6.1 Transport, reconnect, resync

| Upstream (tag v2.0.28) | Contract for this bridge | Ours | Status |
|---|---|---|---|
| `fixture/tui-client.ts:15` `createEventStream()` | the first frame is `server.connected {id:"evt_connected"}`; events emitted before a subscriber attaches are queued and flushed on connect | `tests/server.test.ts` — *serves the handshake the client waits for on /api/event* | ✓ |
| `cli/tui/data.test.tsx:745` *reconnects the event stream and resyncs active data* | `Last-Event-ID` replays only what was missed, in order; the session snapshot after reconnect is current | `tests/server.test.ts` — *replays missed durable events after reconnecting with Last-Event-ID* | ✓ |
| `cli/tui/data.test.tsx:1269` *distinguishes initial connection from reconnection* | the handshake is what marks "connected"; a closed stream is a reconnect, not a new session | `tests/server.test.ts` — same case (handshake asserted on the second stream) | ✓ |
| `cli/tui/data.test.tsx:1328` *tracks session status from active sessions and execution events* | only `session.execution.succeeded\|failed\|interrupted` ends a turn; `/api/session/active` reflects it | `tests/server.test.ts` — *reports true while a turn is running…*; `tests/translate.test.ts` — execution terminal events | ~ (`active` is asserted; the client-side status derivation is the TUI's) |

### 6.2 Sessions, tabs, view

| Upstream (tag v2.0.28) | Contract for this bridge | Ours | Status |
|---|---|---|---|
| `context/session-tabs.test.tsx:440` *derives unread state from server session times* | `Session.time.idle` and `time.viewed` are served and comparable; `outcome` marks failed/interrupted | `tests/server.test.ts` — *records terminal outcome and acknowledges only the observed idle watermark* | ✓ |
| `context/session-tabs.test.tsx:498` *refreshes server session times after terminal events* | after a terminal event, a subsequent `GET /api/session/:id` already carries the new `outcome`/`idle` | same case | ✓ |
| `context/session-tabs.test.tsx:469` and `:517` *acknowledges viewed sessions even when tabs are disabled / only while focused* | `POST /api/session/:id/view {idle}` is accepted independently of any tab state | same case | ✓ |
| `context/session-tabs.test.tsx:561` *retries a failed view acknowledgement* | a repeated `POST /view` with the same watermark is idempotent and safe | same case (stale/duplicate acknowledgement asserted harmless) | ✓ |
| `context/session-tabs.test.tsx:454` *marks unread failed sessions with error styling* | `outcome: "failed"` reaches the session object | `tests/scenarios.test.ts` (error-turn) + `tests/server.test.ts` (view case asserts outcome) | ~ (outcome asserted; styling is the TUI's) |
| `context/session-tabs.test.tsx:609` *distinguishes family questions and permissions…* | permission and form lifecycle events (`permission.asked/replied`, `form.created/cancelled`) must be correct for the *right* session | `tests/server.test.ts` — permission + form reconnect cases; `scripts/e2e-real-tui.sh MODE=permission / MODE=form` | ~ (background-*tab marker* itself is TUI-only) |

### 6.3 Prompts and transcript

| Upstream (tag v2.0.28) | Contract for this bridge | Ours | Status |
|---|---|---|---|
| `cli/tui/data.test.tsx:3332` *admits prompts optimistically and reconciles with the durable echo* | the echo carries the client's id (`session.inbox.enqueued`), and the stored user row keeps that id | `tests/server.test.ts` — *does not leave an optimistic user row after a rejected prompt*; `tests/scenarios.test.ts` — prompt retry | ✓ |
| `cli/tui/data.test.tsx:3434` *hydrates durable pending prompts into the visible transcript* | a retried prompt with the same id resolves to the existing row instead of duplicating | `tests/scenarios.test.ts` — *keeps one user row and one agent turn after a durable retry* | ✓ |
| `cli/tui/data.test.tsx:3548` *rolls back an optimistic prompt the server rejected* | a rejected prompt returns 4xx and stores **no** user row | `tests/server.test.ts` — rejected prompt case | ✓ |
| `cli/tui/data.test.tsx:855` *completes exploration and keeps live rows when a queued prompt is promoted* | `session.step.started` precedes text/tool parts; queued delivery is announced (`inbox.delivered`) | `tests/server.test.ts` — *streams a reply as deltas…*; `scripts/e2e-smoke.sh` scenario 1 event order | ✓ |
| `cli/tui/data.test.tsx:1069` *classifies live tool rows independently of their call ID* | the row id the bridge sends is its own `prt_*`, never the ACP call id — so an id shaped like a content part (`reasoning:0`) cannot be mistaken for one | `tests/scenarios.test.ts` — *gets the bridge's own row id, so classification never depends on id shape* (drives the fixture's `FAKE_ACP_ADVERSARIAL_TOOL_ID=1`) | ✓ |
| `cli/tui/session-rows.test.ts:303` *assigns assistant boundaries to the first rendered row instead of the first text row* | one assistant message carries its parts in emission order | `tests/scenarios.test.ts` — *keeps the order an agent interleaves thought, text and tools in* (`reasoning,text,tool,reasoning,text`) | ✓ |
| `cli/tui/session-rows.test.ts:317` *assigns stable IDs to tool rows for direct navigation* | tool part ids are stable across SSE and reload | `tests/message-projection.test.ts`; `tests/acp-replay.test.ts` | ✓ |
| `cli/tui/session-rows.test.ts:428` *groups adjacent reasoning parts until a visible boundary* | adjacent reasoning stays one part; a tool or text boundary starts a new one | `tests/scenarios.test.ts` (interleaved) + `scripts/e2e-smoke.sh` scenario 16 | ✓ |

### 6.4 History paging

| Upstream (tag v2.0.28) | Contract for this bridge | Ours | Status |
|---|---|---|---|
| `cli/tui/data.test.tsx:1120` *loads older pages until the oldest exploration group is complete…* | `GET /message?limit&cursor` is newest-first, pages are disjoint, `cursor.next` ends at `null` | `tests/scenarios.test.ts` — *returns newest-first pages without duplicates and reaches a null cursor* | ✓ |
| `cli/tui/session-history.test.ts:4` *loads older history and preserves the visible scroll anchor* | page contents are stable across identical requests | same case (deterministic pages) | ✓ |
| `cli/tui/session-history.test.ts:33` *releases the history load after a failed request* | a page that went wrong must not poison the next request for the same cursor; the same cursor returns the same page, and a cursor past the end is a clean empty page with `next: null` | `tests/scenarios.test.ts` — *lets a repeated request for the same cursor succeed after a bad one* | ✓ |
| `cli/tui/session-history.test.ts:55` *does not move a different session after history loads* | a cursor belongs to one session: paging two sessions concurrently never mixes their rows, and neither repeats a row | `tests/scenarios.test.ts` — *keeps two sessions' pagination independent while both are being paged* | ✓ |

### 6.5 Permissions, forms, cancellation

| Upstream (tag v2.0.28) | Contract for this bridge | Ours | Status |
|---|---|---|---|
| `cli/tui/data.test.tsx:2317` *adds and dismisses permission requests from live events* | `permission.asked` carries the v2 shape; a reply emits `permission.replied` | `tests/server.test.ts` — *surfaces a permission request and accepts a reply*; `scripts/e2e-smoke.sh` scenario 2 | ✓ |
| `cli/tui/data.test.tsx:2388` *reconciles active session permissions when the event stream reconnects* | a permission settled during a disconnect replays, and the pending list is empty afterwards | `tests/server.test.ts` — *replays a permission settlement and leaves no stale pending permission after reconnect* | ✓ |
| `cli/tui/data.test.tsx:2436` *dismisses a permission that expired before its reply* | a reply for an unknown/expired request is a clear terminal answer (`404`), not silence | `tests/server.test.ts` — *surfaces a permission request and accepts a reply* (second reply asserted `404`) | ✓ |
| `cli/tui/data.test.tsx:2494` / `:2773` *adds, dismisses, refreshes form requests / reconciles active session forms on reconnect* | form lifecycle events, per-session and global lists agree; a cancellation during a disconnect replays | `tests/server.test.ts` — *replays a form cancellation…*; `tests/scenarios.test.ts` — form terminal race + three-list agreement | ✓ |
| `cli/tui/form.test.tsx:138` *restores the composer when terminal-form revalidation fails* | a settled form answers 404 to stale reply/cancel so the client can recover | `tests/scenarios.test.ts` — *settles once, rejects stale reply/cancel with 404…* | ✓ |
| `cli/tui/prompt-interrupt-status.test.tsx:7` *armed interrupt status renders visible warning text* | `POST /interrupt` returns `200 {interrupted:boolean}`; tools close; `execution.interrupted` is emitted | `tests/server.test.ts`; `tests/translate.test.ts`; `scripts/e2e-real-tui.sh MODE=cancel` | ✓ |

### 6.6 Shell output

| Upstream (tag v2.0.28) | Contract for this bridge | Ours | Status |
|---|---|---|---|
| `component/dialog-shell-output.test.tsx:213` *large captures open at a bounded tail and clicking a shell opens the viewer* | `/api/shell/:id/output` pages by **UTF-8 byte** cursor with `limit`, and a caught-up cursor returns an empty page | `tests/scenarios.test.ts` — *keeps cursor-paged output readable after the shell exits*, *uses UTF-8 bytes…* | ✓ |
| `component/dialog-shell-output.test.tsx:167` *empty output explains redirection, retries errors, and preserves output after removal* | after `DELETE /api/shell/:id` the shell is gone from get/output/list | `tests/scenarios.test.ts` — *removes a deleted shell from list and output endpoints* | ✓ |
| `cli/tui/data.test.tsx` shell rows (`rows.ts` analysis) | a `!command` row is a tool row carrying `metadata.shellID`; the shell object itself carries **no** `output` | `tests/scenarios.test.ts` — *emits shell events the client can actually correlate…*, *scopes each shell to its session…*; `scripts/e2e-real-tui.sh MODE=shell` and `ENTRY=1 MODE=shell` | ✓ |

### 6.7 Deliberately not migrated

| Upstream area | Why not |
|---|---|
| tab layout, width, marquee, mouse drag (`component/session-tabs-mouse.test.tsx`, `context/session-tabs-model.test.ts`) | the TUI owns its own rendering; no bridge change can fix it |
| form editor internals: paste, cursor, custom multiselect (`cli/tui/form.test.tsx:291`+) | same |
| shell viewer scroll position and follow behaviour | the client-side viewer; the bridge only supplies bytes |
| theme, ANSI colour, spinner animation | same |
| compaction, inbox queue, retry (`data.test.tsx:969`, `:1795`, `:1613`+) | this bridge does not advertise `session.compaction`, and opencode v2's inbox queue has no ACP counterpart — these are the *negative* contracts documented in `docs/ACP-COMPAT.md` |

### 6.8 How to use this table on a new release

1. `git diff <old-tag> <tag> -- packages/tui/test` — anything touching a row above is a candidate.
2. For each changed test, re-read it at the new tag and compare against the **Contract** column.
3. If the contract changed: fix the bridge, or add a row (and a test) here.
4. If a row's **Status** is `~` or `✗`, that is the backlog; closing one means updating its status.
5. Re-run `pnpm verify` and `pnpm verify:version <tag>`.

## 7. Rules this document is bound by

- Read the **released tag**, never a working tree.
- A new test is only migrated if a **change to this bridge** could make it fail; otherwise it is
  the TUI's own business and is listed as such.
- No test may mock ACP: extend `tests/fake-acp-agent.mjs`.
- Every migrated contract is documented in `docs/SCENARIOS.md` with what it proves.
- Real-screen assertions live in `scripts/e2e-real-tui.sh`; bridge-level assertions live in
  Vitest. Do not blur the two.
