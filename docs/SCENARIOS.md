# Scenario matrix — what the fake agent can do, and what proves it

> 中文版：[SCENARIOS.zh.md](SCENARIOS.zh.md)

The fake ACP agent (`tests/fake-acp-agent.mjs`) is selected with
`FAKE_ACP_SCENARIO=<name>`. Each scenario is one coherent set of behaviours; every
`FAKE_ACP_*` flag still works on its own. "Asserted by" names the test that fails when
the **client** misbehaves — not one that passes because the agent echoed what it was told.

#### `!command` renders inline and remains available in the shell-output dialog

Read from the shipped v2.0.28 client: the composer shell tab opens
`<DialogShellOutput shell={entry} location={entry.location} />` and pages
`GET /api/shell/:id/output` (`PAGE_BYTES = 64 * 1024`). The transcript also renders the
command inline through its shell tool row.

### `!command` (the shell) — screen-verified in both launch shapes

The TUI sends `POST /api/session/:id/shell`; the bridge waits for the command to settle and
emits `session.shell.started` and `session.shell.ended`. The latter must carry the upstream v2
`Shell.Output` envelope, **not** a string:
`{ output, cursor, size, truncated }`. `stream-v2.transport.ts` passes that object to
`shellTerminal()`, which reads all four fields; the former plain-string payload left those fields
undefined and made the single-entry TUI show an empty card.

`MODE=shell` drives `!echo SHELLIN | tr A-Z a-z` and requires `shellin` on screen. It runs both
as the normal split bridge/TUI setup and as `ENTRY=1` — the product's actual one-command launch
where the defect lived — in `pnpm verify`. The bridge additionally emits the associated tool
part (`metadata.shellID`, `input.command`, `input.workdir`) that the row reads.

## Transport contracts borrowed from the official TUI suite

- **SSE reconnect:** a real `node:http` stream reconnects with `Last-Event-ID`; the hub sends
  `server.connected` first, replays only missed durable events in order, and the ordinary
  session-list snapshot still contains the missed session. This protects the bridge side of the
  official TUI's reconnect/resync behavior.
- **Reconnect pending-state convergence:** a permission answered while disconnected replays
  `permission.replied` after reconnect and is absent from the pending-permission list; a form
  cancelled while disconnected similarly replays `form.cancelled` and is absent from both form lists.
- **Shell cursor/final flush:** the global shell route is polled with a UTF-8 **byte** cursor
  while output grows; a final read after exit reaches `cursor === size`, preserves the complete
  text, and `Number.MAX_SAFE_INTEGER` returns the empty caught-up page. This is the bridge
  contract consumed by the official shell-output viewer.
- **Shell deletion:** `DELETE /api/shell/:id` terminates and removes the shell; subsequent
  get/output requests are `404` and the shell is absent from the list.
- **Multi-session isolation:** two active sessions are interrupted independently; settling one
  must remove only that session from `/api/session/active` while the other remains running.
- **Pagination resilience:** a nonsense cursor is treated as "from the top" rather than failing, a
  cursor past the end is a clean empty page, the same cursor returns the same page, and two sessions
  paged concurrently never mix their rows.
- **Adversarial ACP call ids:** a tool call whose ACP id looks like a content part (`reasoning:0`)
  still gets the bridge's own `prt_*` row id, so nothing classifies rows by id shape.
- **Prompt retry idempotency:** retrying the same client message id produces one user row and
  one agent turn, rather than duplicate transcript content; a rejected prompt leaves no ghost
  user row in the transcript.
- **Session view acknowledgement:** a terminal turn records `outcome` and `time.idle`; the
  official `POST /api/session/:id/view` route acknowledges only that exact idle watermark and
  emits `session.viewed`, so stale views cannot mark a newer result as read.
- **Transcript pagination:** newest-first `limit`/`cursor` pages are disjoint, reach a null
  cursor, and preserve all user and assistant rows across page boundaries.
- **Terminal form races:** after one reply or cancel settles a form, stale reply/cancel requests
  return `404`, the pending form list is empty, and the underlying turn reaches its terminal state.

## Which of these are driven against the REAL opencode v2 TUI

Most rows are asserted through the HTTP surface (`scripts/e2e-smoke.sh`) or on the
client directly (vitest). A dozen-plus runs (15 `MODE=` branches) drive a real TUI in tmux, through
`scripts/e2e-real-tui.sh`, and each is a different interaction or launch shape:

| mode | command | what it proves |
|---|---|---|
| `history` (default) | `pnpm e2e:tui` | a turn renders every layer on screen, and reopening the session renders the same layers from history |
| `stale-prompt` | `MODE=stale-prompt bash scripts/e2e-real-tui.sh` | the agent still reports a prompt as active: the bridge cancels it, retries once, and the reply renders without `already has an active ACP prompt` |
| `queue` | `MODE=queue bash scripts/e2e-real-tui.sh` | a follow-up typed during a held turn shows as `N queued`, never the agent's "already has an active ACP prompt" error, and runs after the turn is released (`FAKE_ACP_HOLD_ON` gate) |
| `tool-stages` | `MODE=tool-stages bash scripts/e2e-real-tui.sh` | a tool whose input arrives after the pending frame (opencode v2's shape: `{cwd}` first, the command/query with `in_progress`) renders `$ echo hello` and the grouped search row, never "Writing command…"/"Searching web…". The fixture is `FAKE_ACP_TOOL_STAGES=1` |
| `permission` | `MODE=permission bash scripts/e2e-real-tui.sh` | the permission footer renders, the keys reach it, and the TUI really POSTs `/permission/:id/reply` |
| `form` | `MODE=form bash scripts/e2e-real-tui.sh` | the elicitation form renders, is answered, is submitted, and closes with nothing left pending |
| `cancel` | `MODE=cancel bash scripts/e2e-real-tui.sh` | Escape twice reaches the client: `session.interrupt`, and the agent receives `cancelled` |
| `shell` | `MODE=shell bash scripts/e2e-real-tui.sh` | the split bridge/TUI setup renders transformed `!command` output |
| `shell` + `ENTRY=1` | `ENTRY=1 MODE=shell bash scripts/e2e-real-tui.sh` | the product's actual single-entry launch renders the same output |
| `shell-history` | `MODE=shell-history bash scripts/e2e-real-tui.sh` | after restarting the TUI and reopening the session, the `!command` row **and its output** are still on screen |
| `patrol` | `MODE=patrol bash scripts/e2e-real-tui.sh` | every slash command the shipped TUI offers, driven once: the pane stays alive, no `UnexpectedStatus`, a per-command snapshot lands in `.artifacts` (its first run caught `/rename` answering 200 against a declared 204) |
| `cd` | `MODE=cd bash scripts/e2e-real-tui.sh` | `/cd` moves the session end to end: the "↳ Moved to" row, the footer, `!pwd`, and the agent's own next answer all follow the new directory, and the replay the re-load triggers does not render twice |
| `unsupported-verb` | `MODE=unsupported-verb bash scripts/e2e-real-tui.sh` | `/compact`, `/btw` and `/undo` show readable failures on screen, never `UnexpectedStatus`, while verbs the spec declares empty still get 204 |
| `restore-turn` | `MODE=restore-turn bash scripts/e2e-real-tui.sh` | after restarting and restoring the session, a **new** turn's tool call renders on screen (and the turn finishes) |
| `restore-tab` | `MODE=restore-tab bash scripts/e2e-real-tui.sh` | the owner's path: close the program, reopen it, `ctrl+x` `l`, pick the session — the transcript comes back and no card names the placeholder model |

Everything else in the table below is API-level or unit-level. That is not a
formality: three of this project's real bugs were found only because a real TUI was
driven (a missing `sessionID` in `session.created`, an empty user row from streaming
without storing, and a cancellation the client answered with 204 — `UnexpectedStatus`
in the real client's log every time).
Screens are captured to `.artifacts/`.

| scenario | the agent… | asserted by | the TUI renders | if nothing, why |
|---|---|---|---|---|
| `rich-turn` | thinks, calls a tool, then replies | smoke 11 | thinking block, tool card, reply | |
| `plan` | sends a `plan` update | smoke 12 | **nothing** | opencode v2 has no todo surface. Measured on v2.0.28: on screen there is only the reply. We log it (`ACP plan update … has no opencode v2 surface`). |
| `todo` (`FAKE_ACP_TODO=1`) | calls `todowrite` with a completed todo list | **real TUI `MODE=todo`** | sidebar `Todo` + completed/in-progress/pending rows | |
| `permission` | asks, then waits for the answer | smoke 13 (approve + reject), **real TUI `MODE=permission`** | `△ Permission required` footer, `Allow once / Reject` | |
| `elicit-form` | asks a structured question | smoke 14 (cancel path), **real TUI `MODE=form` (renders, answers, submits, closes)** | one screen per field plus a summary; hints `enter confirm`, `enter toggle`, `enter submit` | |
| `elicit-url` | asks in `url` mode | smoke (refusal) | nothing | we advertise `form` only, and the spec forbids answering a url request with a form, so we refuse with `-32602` |
| `title-and-model` | renames the session, switches model | smoke 15 | the new title, the new model in the footer | |
| `interleaved` | thought, text, tool, thought, text | smoke 16 | two reasoning parts and two text parts, with the tool between them | |
| `slow` | pauses inside the turn (`FAKE_ACP_DELAY_MS`) | smoke 17 | the working state, then the reply | |
| slow `session/new` | delays `session/new` by 2.5s (`FAKE_ACP_DELAY_SESSION_NEW_MS`) | unit | the composer appears late; the model catalog still gets the real models rather than the `acp/default` placeholder | |
| `crash` | exits mid-turn | smoke 18, unit | what it sent before dying; the turn still settles | |
| `error-turn` | replies, then `stopReason: 'error'` | smoke 9, unit | the partial text and the failure | |
| resume-capable (`FAKE_ACP_CAPS_RESUME=1`) | advertises `session/resume` and accepts it, replaying nothing | unit; **real TUI `scripts/e2e-epilogue.sh`** | the tab keeps its real name (no marker), the screen starts empty, and a `◈ Notice` names the missing `session/load` | ACP defines `session/resume` as "reconnect WITHOUT replaying history". Measured on the real plain-ACP profile (): the next turn runs, and whether the model remembers the conversation varied with the model — so the fixture replays nothing and the docs promise nothing either way |
| resume-fails (`FAKE_ACP_RESUME_FAILS=1`) | advertises `session/resume`, then rejects the call | unit | a **new** conversation, titled `[new conversation] <dir>`, a `◈ Notice` in the transcript saying the earlier one could not be reopened, and the reason in the log | the old conversation cannot be reconnected; the bridge recovers with a usable tab and says so |
| no reconnect at all (the default fixture) | advertises neither `loadSession` nor `session/resume` | unit | a new conversation, titled `[new conversation] <dir>`, a `◈ Notice` saying the agent cannot reopen a session, and neither method is called | ACP forbids calling either without its capability |
| `error-response` | answers `session/prompt` with a JSON-RPC error | unit | the failure |
| `late-reasoning` (`FAKE_ACP_LATE_REASONING=1`) | sends an `agent_thought_chunk` **after** the prompt result (a dsh background job) | unit: no `session.reasoning.*` after `session.step.ended`, the part is in the transcript with an end time | nothing transient — no thinking spinner on a completed message | | |
| `hostile` | sends unadvertised, unknown and malformed updates, plus one for a tool that never existed | smoke 8, unit | the reply; the unknown updates are logged, not rendered | |
| `tools-many` | completes one tool, fails one, abandons one | smoke 10, unit | three cards; the abandoned one is closed rather than left spinning | |
| `images` | advertises image prompts, and one that does not | unit: forwarded ✓, dropped loudly ✓, refused loudly ✓ | — | |
| | | | | **Fixed.** The prompt surface now builds ACP image blocks from the TUI's `files`, `filterPromptBlocks` still gates them on the capability the agent advertised (and logs what it drops), and an attachment with no ACP route — a PDF, say — is refused with 400 and a readable reason instead of being dropped in silence. Found by reading the TUI's own payload type, not by assuming. **Verified end to end (real TUI in tmux):** the `@` picker searches through `GET /api/fs/find` (implemented: breadth-first substring search — an always-empty answer had made every `@` say "No matching files", so the image path's entry point was dead), the picked file travels as a `file://` URI (measured v2.0.30 — NOT the base64 `{data}` the schema suggests), the bridge reads the bytes and forwards a base64 ACP image block, and the image-capable fake agent's reply — `you said: … images:1` — rendered on screen. Non-image URIs are refused with a readable 400, never dropped silently. Pinned by three unit tests (`fs/find` search shapes, the file-URI image block, the refusal). **Still unverified**: the whole chain from attachment to frame in one real session — every step above was checked on its own, but never in a single live run |
| `usage` | reports `usage_update` `{used, size}` | unit — asserts the SSE event `session.usage.updated` | the sidebar meter and the row's token/cost fields | |
| `long-output` | returns 400 lines from a tool, and a reply in 17-character chunks | unit | the whole result — the assertion is that the projection stays above 10KB | | |

Rows in italics are gaps. A scenario without an assertion is a fixture, not a test: add
the assertion, or record it as missing — which is what this table is for.
