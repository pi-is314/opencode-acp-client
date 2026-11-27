# ACP compatibility and degradation

> 中文版：[ACP-COMPAT.zh.md](ACP-COMPAT.zh.md)

ACP is a **negotiated** protocol: every agent advertises what it can do, and the
bridge must only call and announce capabilities that were negotiated. This document records
the bridge's compatibility and degradation rules against ACP and the opencode v2 HTTP/TUI
surface. Agent-specific probes, counts and run notes belong in [DEVELOPMENT.md](DEVELOPMENT.md).

**Scope:** [ACP-MATRIX.md](ACP-MATRIX.md) is the detailed, schema-first source of truth:
method inventory, every `session/update` variant, deliberate deviations and the HTTP mapping.
This document is the shorter runtime guide: negotiated capability handling, degradation, and
opencode v2 TUI surfaces with no compatible ACP feature.

## The rule

> A capability that was not advertised is treated as **absent**. Nothing is
> attempted optimistically, and nothing is left unanswered.

Two failure modes drive this:

- **Hang.** An unanswered agent→client request blocks the agent forever. There is
  no timeout on the agent's side. So we always answer, even to refuse.
- **Silent no-op.** A request the agent accepts but does not implement may
  resolve with an empty result, which the UI renders as nothing at all. Worse
  than an error, because there is nothing to debug.

The rule cuts both ways, and that is what keeps the client generic rather than
shaped around one agent: we announce only what we can service, and we service
whatever an agent legitimately sends under the capabilities we announced.

`session/list` is only called when the agent advertised
`sessionCapabilities.list`, and refused otherwise. See the degradation table below.

## What this client announces

`initialize` sends `clientCapabilities: { elicitation: { form: {} } }` — one
constant, `CLIENT_CAPABILITIES` in `src/acp/capabilities.ts`, guarded by
`tests/capabilities.test.ts`.

| Announced | Path behind it |
|---|---|
| `elicitation.form` | `AcpClient.onRequest('elicitation/create')` → `BridgeServer.awaitElicitation` → the TUI's form routes |

| Deliberately absent | Why |
|---|---|
| `elicitation.url` | No browser surface, and the spec forbids falling back to form mode for the sensitive flows url mode exists for |
| `fs.readTextFile` / `fs.writeTextFile` | Not implemented; the agent should use its own tools, and an explicit `-32601` is what a caller gets |
| `terminal` | Same; the TUI's `!` shell is a local HTTP route, not an ACP callback |
| `session.notices` | opencode v2 has no surface to render a notice, so announcing would only produce updates nothing displays |
| `session.compaction` | Same: no v2 compaction surface |
| `session.configOptions.boolean` | Only `category: "model"` and `thought_level` are projected; a boolean toggle has nowhere to land |

Per ACP, an agent **MUST NOT** request a mode that was not advertised — and a
request in an unadvertised mode is answered `-32602`, not silently mishandled.

## Capability matrix

| ACP capability or method | Bridge behaviour | opencode v2 result |
|---|---|---|
| `initialize` | Negotiates and records the agent capabilities | startup capability state |
| `session/new` | Creates the agent-side session lazily on the first prompt | normal session lifecycle |
| `session/prompt` | Forwards supported prompt blocks; has a dedicated prompt timeout | a streamed turn |
| `session/update` text, thought and tool variants | Translates the supported variants | text, reasoning and tool rows |
| `session/request_permission` | Queues the request and returns the user's decision or `cancelled` | permission footer |
| `session/load` | Called only after the agent advertised the capability; failure is loud and falls back to a fresh session | resumed context when the agent supplies replay data |
| `session/list` | Called only after `sessionCapabilities.list` was advertised | optional agent session discovery/title lookup |
| `promptCapabilities.image` / `embeddedContext` | Forwarded only when advertised | attachment/context support when available |
| agent → client `fs/*` / `terminal/*` | Never advertised; answered `-32601` if sent anyway | no invented TUI surface |
| agent → client `elicitation/create` with `form` | Supported when it conforms to the declared form capability | form dialog |
| unadvertised elicitation mode or unknown reverse request | Refused explicitly (`-32602` or `-32601`) | no hanging agent |

## How the bridge degrades

| When | Behaviour | Where |
|---|---|---|
| `initialize` returns nothing useful | treated as the minimal profile, `reported=false` | `effectiveCapabilities` |
| `session/load` called without the capability | `AcpMethodNotFound`, catchable — the caller starts a fresh session instead | `AcpClient.loadSession` |
| Agent omits `sessionCapabilities.list` | `session/list` is refused before it is sent (the spec forbids calling it without the gate); the directory basename stays as the title | `canListSessions` / `AcpClient.listSessions` / `applyBackendTitle` |
| Prompt contains an unsupported block | block dropped before sending + logged | `filterPromptBlocks` |
| Agent calls `fs/*` or `terminal/*` | explicit `-32601` error (we never advertised it) | `clientCallbackSupport` |
| Agent asks for an elicitation mode we did not advertise | `-32602` **before** any handler runs; nothing is published to the form queue | `AcpClient.onRequest` |
| Agent's elicitation schema cannot be rendered completely | `-32602`; no partial form, so no answer that silently mismatches the schema | `formFromElicitation` |
| Agent asks permission with no handler installed | answered `cancelled`, so it fails closed instead of hanging | `AcpClient.onRequest` |
| Agent asks anything else unknown | explicit `-32601` | `AcpClient.onRequest` |
| Agent's tool status string is unfamiliar | mapped to `running`, never `completed` | `mapToolStatus` |
| Agent reports a tool as `cancelled` / `canceled` | terminal `error`, not a spinner — ACP defines no such status on the wire, but agents send it | `mapToolStatus` |
| `session/update` type we do not know | ignored + logged | `AcpTranslator.apply` |

## What a missing capability looks like to the user

The tables above are written from the protocol side. This one is written from the
**screen**: if an agent does not advertise X, what still works, and what can the user
not see? Per-agent measurements (with the exact `initialize` responses) live in
[AGENT-CAPABILITIES.md](AGENT-CAPABILITIES.md).

| Agent does not advertise | Still works | The user cannot see | Marker / wording |
|---|---|---|---|
| `loadSession` (it has `sessionCapabilities.resume`) | the restore **succeeds** — same session, and the agent's context may continue | the earlier conversation (ACP's `session/resume` replays nothing) | tab keeps the conversation's **real name** (no marker) **plus** a `◈ Notice` in the transcript: *Resumed without showing history: this agent "<agent command>" has no session/load capability* |
| neither `loadSession` nor `resume` | a conversation can still be created | any restore; the tab becomes a new one | tab `[new conversation] <name>` + a `◈ Notice` saying the old session could not be reopened |
| a title surface (`session_info_update`, and no `title` in `session/list`) | the session works; the agent's own name is never used | the conversation's real name — it falls back to the first prompt's words, then to the directory basename | plain fallback title, no marker |
| `promptCapabilities.image` / `embeddedContext` | text prompts; the turn runs | attachments and embedded context (those blocks are dropped and logged) | none — the block is gone before it is sent |
| `sessionCapabilities.delete` | the tab is removed locally and the map entry forgotten | the agent-side session actually being deleted | log line `agent could not release <id>` |
| `sessionCapabilities.list` | sessions work; titles are whatever we derived | discovery of older conversations and backend titles | directory/derived title |
| `session/set_config_option` | whatever model the session started with | switching models; the route answers `400` naming the agent as the reason | `400 … this session's agent does not offer …` |

**Worked example — dsh's official `acp` profile** (`dsh --profile acp`):
it advertises `{close, list, resume}`, `promptCapabilities: {image: false, audio: false,
embeddedContext: false}` and **no `loadSession`**. So a restored session resumes correctly but shows
no history — the tab keeps its real name and the `◈ Notice` explains why; its titles come only from the first
prompt (now persisted in the map) or the directory; image blocks are dropped; and deleting a tab does
not delete the agent's session. The other common agents (`opencode acp`, `claude-agent-acp`,
`codex-acp`) advertise `loadSession`, so none of those four symptoms apply to them.

★ Its reasoning effort is a config option named **`reasoning_effort`**, not `effort`. The bridge
matches the option by `category` (`thought_level`) with the ids `reasoning_effort` / `effort` as
fallbacks, so `/effort high` reaches it and the agent then streams real `agent_thought_chunk`
updates (measured: 16 thought chunks in one turn). An earlier reading of this project concluded
that profile "has no effort option" — that was a probe that only looked for the id `effort`;
match the CATEGORY, or the next agent's choice of name hides the option entirely.

## What ACP has no way to express: moving a session to another directory

opencode's TUI has `/cd`, and the server implements it as `session.move`: the session id stays the
same and a `move` item is dropped into that session's inbox (`packages/core/src/session/move.ts`),
so the conversation's `location` changes in place and the next step runs in the new directory.

**ACP has nothing equivalent.** The session's `cwd` is part of what a session IS
([session-setup](https://agentclientprotocol.com/protocol/v1/session-setup)): it is passed to
`session/new`, `session/load` and `session/resume`, it must be part of the session's effective root
set, and it stays the base for relative-path resolution. The spec defines no `session/move`.
`additionalDirectories` is not a substitute — it ADDS roots while keeping `cwd` primary.

So the bridge implements `/cd` as the closest thing the protocol allows: `session/load` of the same
session id with the new `cwd`. Agents decide how strict to be about that, and both answers are legal:

| Agent | `session/load` with a different `cwd` | What the user sees |
|---|---|---|
| `dsh --profile acp`, `opencode acp`, `pi-acp` | accepted; the session continues in the new directory | `/cd` works, the transcript is replayed onto the new location |
| **`qwen --acp`** | **rejected**: `Invalid params: The live session belongs to another workspace` | `400 the agent refused the move: …`, and the session stays where it was |

★ Measured against qwen directly, without the bridge: a session created in `/tmp/qdir1` and then
loaded with `cwd: /tmp/qdir2` answers `-32602 "The live session belongs to another workspace."`
It also answers `-32601 "Method not found"` to `session/close`, so "close then load" is not a way
round it either. **There is no client-side fix** — a new session in the new directory would lose
the conversation identity that `/cd` exists to preserve.

## Capabilities opencode v2 does not have

Some ACP features have nowhere to land in the TUI. That is not a bridge gap, and
the bridge does not invent a surface for them — an event nothing renders looks
exactly like a working feature until you notice the screen is empty.

| ACP side | opencode v2 | Evidence |
|---|---|---|
| `plan` update (the agent's todo list) | **no todo surface** | opencode v2 TUI has no todo capability |
| subagents | rendered as **tool cards**, never as child sessions | ACP carries a single session per prompt, so no child session is available to map; child activity is represented through tool rows instead |
| `lsp` configuration | accepted but **not run** | `/docs/migrate-v1`: "V2 accepts and preserves `lsp` configuration, but it does not run language servers, expose LSP tools, or produce LSP diagnostics." This is the one place the migration guide names a replacement (the project's lint, typecheck, or compiler commands). |
| v2's builtin agents (`build`, `plan`, `general`, `explore`) | **not exposed** | ACP has no agent/mode list — the agent's `session/new` advertises models and reasoning effort through config options and nothing else. `/api/agent` therefore answers with one synthetic primary agent. Switching agents is a no-op and says so with a 204 rather than pretending. |

### What the sidebar does show

`context` (tokens and percent), and the working directory with its branch.
Everything else in v1's sidebar — context detail, compact, the opencode v2 version,
LSP status, todos, MCP servers — has no v2 equivalent to attach to. MCP in
particular has no list to render: ACP carries none (`session/new` takes servers
as **client** input), the client is not an MCP host, and we serve no MCP server
list, so the sidebar's MCP section simply stays empty.

Discovery by running the agent with its own configuration flag was **removed on
purpose**: it assumed which agent it was talking to, and an agent that ignores
argv simply waits on stdin — which holds up the ready line and makes the client
look broken. The same reasoning applies to every other probe `findExecutable`
refuses to run.
