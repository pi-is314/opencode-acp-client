# What this client owes the agent

This repository is an ACP **client**. It speaks ACP over stdio to one agent
process per session and serves opencode v2's HTTP/SSE surface to the opencode
v2 TUI, which is its UI. It claims **`protocolVersion: 1`** (`src/acp/client.ts`) —
one integer, sent on every `initialize`.

```bash
oc-acp-client -- <agent command>                # TUI + adapter (default)
oc-acp-client --no-tui -- <agent command>    # HTTP/SSE only; what the e2e harness drives
```

The ACP surface is the product's protocol face; the `/api/*` surface is the UI
adapter and an implementation detail (see [PROTOCOL.md](PROTOCOL.md)).

`SIGINT`/`SIGTERM` stop the TUI and dispose every agent and shell by explicit PID
(never a name-based kill), and the TUI's exit code becomes the process's. A
missing agent command fails at startup with a readable error (`findExecutable`,
`src/index.ts`), and a relative path is resolved against the directory the agent
will run in.

Every row below was read off the source or the harness — **observed, not
invented**. Quotes are from ACP v1 stable.

## Obligations

| ACP requirement | What we do | Where |
|---|---|---|
| "Clients and Agents **MUST** treat all capabilities omitted in the `initialize` request as **UNSUPPORTED**." | `clientCapabilities` is exactly `{ elicitation: { form: {} } }` — one constant, one announced mode, nothing speculative. | `CLIENT_CAPABILITIES`, `src/acp/capabilities.ts`; guard test `tests/capabilities.test.ts` |
| "Before attempting to list sessions, Clients **MUST** verify that the Agent supports this capability by checking the `sessionCapabilities.list` field in the `initialize` response." | The agent's answer is normalised to explicit booleans and anything missing is `false`. `session/load` is only called when `agentCapabilities.loadSession` is true; otherwise the session is `session/resume`d bare and that is said out loud. `session/list` is gated on `sessionCapabilities.list` and refuses otherwise (a client **MUST NOT** call it without the gate), so an agent that omits it simply keeps the directory basename as the title. | `effectiveCapabilities` / `canLoadSession`, `src/acp/capabilities.ts`; `AcpClient.listSessions`; `applyBackendTitle`, `src/server.ts` |
| Every JSON-RPC request **MUST** be answered. An unanswered agent→client request is a deadlock: there is no timeout on the agent's side. An unrecognised extension method must still answer `-32601`. | Every reverse request gets a result or an explicit error, from one place. `session/request_permission` and `elicitation/create` (form mode) are serviced; `fs/*` and `terminal/*` answer `-32601` with a reason; anything else answers `-32601`. No branch falls through silently. | `AcpClient.onRequest`, `src/acp/client.ts`; `clientCallbackSupport`, `src/acp/capabilities.ts` |
| "Agents **MUST NOT** request a mode the Client has not advertised." / "Requests using a mode the Client has not advertised produce JSON-RPC `-32602` (Invalid params)." | A `mode` that is not `form` is refused with `-32602` **before** any handler runs, and nothing is published to the form queue. | `AcpClient.onRequest`, `src/acp/client.ts`; e2e scenario 6 |
| Form mode is a flat JSON Schema, and `content` on an `accept` **SHOULD** conform to it. | The schema is mapped onto opencode v2's `Form.Info` (id carries `frm_`, `fields` non-empty): `string` (optionally an `enum` → options, plus `format` / `minLength` / `maxLength` / `pattern` / `default`), `number`, `integer`, `boolean`, and an `array` of string enum → the TUI's `multiselect`. The agent's `message` becomes the form title, falling back to `Input requested` because the title is required and non-empty. | `formFromElicitation`, `src/server.ts`; `FormInfo` / `FormField`, `src/contract.ts`; `tests/elicitation.test.ts` |
| A schema cannot be half-rendered: an answer that does not match it is indistinguishable from a good one. | A schema we cannot render **completely** is refused with `-32602` rather than shown partially — no `properties` object, a property type outside the subset, or zero fields. | `formFromElicitation` (`AcpError(-32602)`), `src/server.ts` |
| The three documented elicitation outcomes are `accept`, `decline`, `cancel`. | The answer the TUI hands back becomes `content` of the `accept`; dismissing the dialog becomes `cancel`. `decline` has no control in this UI, so it is never sent. | `BridgeServer.settleForm`, `src/server.ts`; the routes below |
| `session/request_permission` is the baseline reverse method. | A queue plus a `permission.asked` event; the TUI's `{reply:"once"\|"always"\|"reject"}` is mapped onto the ACP `selected` outcome (`cancelled` when nothing maps). With no handler installed the request is answered `cancelled`, so it fails closed instead of hanging. | `awaitPermission` / `replyPermission` / `mapPermissionResponse`, `src/server.ts`; `AcpClient.onRequest` |
| "The Client **SHOULD** preemptively mark all non-finished tool calls pertaining to the current turn as `cancelled` as soon as it sends the `session/cancel` notification." | `POST /api/session/:id/abort` sends `session/cancel` and then closes every unfinished tool row. opencode v2 has no `cancelled` tool state, so the terminal state it does have is used and carries the reason as output. | abort branch, `src/server.ts`; `AcpTranslator.cancelOpenToolCalls`, `src/translate/events.ts`; e2e scenario 7 |
| "The Client **MUST** respond to all pending `session/request_permission` requests with the `cancelled` outcome." | Every pending permission of that session is answered `{outcome:{outcome:"cancelled"}}`, and every pending form is settled as `cancel`, so the elicitation gets its `cancel` action too. | `cancelPendingPermissions` / `cancelPendingForms`, `src/server.ts` |
| "Clients **MUST** restrict types of content according to the Prompt Capabilities established during initialization." | `image`, `audio` and embedded `resource` blocks are dropped before sending unless the matching `promptCapabilities` flag was advertised, and each drop is logged by type. `resource_link` is always kept: a link to a resource is baseline in ACP, and only embedded content needs the capability. | `filterPromptBlocks`, `src/acp/capabilities.ts`, called from the prompt path in `src/server.ts`; `tests/capabilities.test.ts` |
| `session/list` entries carry a human-readable `title`; `session_info_update` is the push mechanism for title / `updatedAt`. | The title is read from `session/list` once the ACP session id is known, or taken from the agent's `session_info_update`. The session id is never shown as a title. Both paths emit `session.renamed`, the only frame the TUI's store reads — see the note below. | `applyBackendTitle`, `src/server.ts`; `AcpTranslator.apply` (`sessionInfoUpdate`), `src/translate/events.ts` |
| `_meta` carries extensions: an implementation must not add fields at the root of a spec type, and a `_`-prefixed method is an extension that must still be answered. | `_meta` on a `session/update` — on the params, the update, or both — is merged into the session record and never overwrites an agent key (`AcpClient.onNotification` merges the two levels; `AcpTranslator.apply` merges into `record.meta`). It is not projected onto the HTTP surface, because opencode v2's schemas have no field for it: preserved, not dropped, and not invented. An unknown `_`-prefixed request is answered `-32601`, not left silent. | `AcpClient.onNotification`; `AcpTranslator.apply`; `SessionRecord.meta`, `src/state.ts` |

> The capability gates above are enforced before a request goes out, each in one
> place: `session/load`, `session/list`, the prompt content types, and the
> elicitation mode all refuse rather than ask and hope.

> **`session.updated` is emitted, and the TUI ignores it.** Verified against the
> client's store (`packages/client/src/solid/data.ts`): it has a case for
> `session.renamed` `{sessionID, title}` and **none** for `session.updated`. A
> title change — the TUI's `PATCH /api/session/:id`, or the agent's
> `session_info_update` — therefore only reaches the sidebar through
> `session.renamed`, and the bridge emits both. Emitting only the session event
> looks correct in a log and does nothing on screen.

### The elicitation routes

`elicitation/create` is surfaced through the TUI's own form plane. Note the two
different response envelopes: the location-wide routes use `{location, data:…}`,
the session-scoped ones answer `{data:…}`.

| Route | Response |
|---|---|
| `GET /api/form/request` | `{location, data:[Form.Info]}` — every pending form |
| `GET /api/form` | `{location, data:[Form.Info]}` — the same list |
| `GET /api/session/:id/form` | `{data:[Form.Info]}` — **not** the location envelope |
| `GET /api/session/:id/form/:formID` | `{data: Form.Info}` |
| `GET /api/session/:id/form/:formID/state` | `{data:{status:"pending"}}` |
| `POST /api/session/:id/form/:formID/reply` | body `{answer:{…}}`, 204 |
| `POST /api/session/:id/form/:formID/cancel` | 204 |

An unknown or foreign `:formID` answers 404 `{error:"form not found"}`; a reply
whose `answer` is not an object answers 400. The routes are registered before
the generic session matcher, for the same reason the permission reply route is
(see [PROTOCOL.md](PROTOCOL.md)).

## Deliberately not implemented

| Absent | Why |
|---|---|
| `fs.readTextFile`, `fs.writeTextFile` | Not announced. The agent should use its own tools. A non-conforming agent that calls anyway gets an explicit `-32601` (`clientCallbackSupport`), never silence. |
| `terminal/*` | Not announced, explicitly refused if called. The TUI's own `!` shell is served by the adapter (`POST /api/shell`), not by ACP. |
| `elicitation.url` | There is no browser surface to open, and the spec forbids the shortcut: "If the Client does not support URL mode, the Agent **MUST NOT** fall back to form mode; it must use another safe flow or fail the operation." Announcing `url` would be a promise we cannot keep. |
| `session.notices` | Not announced, so an agent must not send `notice` updates. opencode v2 has no surface to render a live notice; announcing would only produce updates nothing displays. |
| `session.compaction` | Not announced, so `compaction_update` / `compaction_summary_chunk` must not be sent. There is no opencode v2 compaction surface either. |
| `session.configOptions.boolean` | Not announced, so an agent must not include `type: "boolean"` options. Config options are recorded, but only `category: "model"` and `thought_level` / `reasoning_effort` are projected into `/api/model`; a boolean toggle has nowhere to land. |

## How this is verified

| Check | What it proves |
|---|---|
| `pnpm test` — 12 files, 142 passed, 0 skipped | The unit suite, SSE flows included. Those six cases used to be skipped because vitest buffers a `fetch` body; they now read the stream over `node:http`, which un-skipping them proved was worth doing (it exposed a racy subscription and an assertion that could never have passed). Route shapes carry their own tests in `tests/routes.test.ts`. |
| `tests/capabilities.test.ts` | The announcement guard: `CLIENT_CAPABILITIES` is exactly `{elicitation:{form:{}}}`, `fs` / `terminal` / `url` / `notices` / `compaction` are absent, and the one method the announcement promises has a servicing path. |
| `scripts/e2e-smoke.sh` | 20 scenarios against a fake agent and the real HTTP/SSE surface: plain turn; permission round trip (it asserts the agent **received** the selected outcome); `!` shell; agent-driven config change + rename; elicitation through the form routes (it asserts the agent received the exact answer the user typed); url-mode refusal with `-32602` and no form published; abort answering a pending permission with `cancelled`. |
| `scripts/e2e-entry.sh` | The single entry point: the TUI's exit code propagated, the TUI was launched with `--server`, logs went to a file, no leftover TUI/agent, SIGTERM stops both, a missing agent command fails fast. |
| `scripts/e2e-real-agent.sh` | Protocol verification against a **real** agent, with no model turn by default (`PROMPT=1` sends one, which spends tokens). Measured: the first agent measured yields 2 real models (`deepseek-official/deepseek-flash`, `deepseek-official/deepseek-v4-pro`); a second, separate ACP implementation yields 42 models across providers. The assertion distinguishes real models from the `acp/default` placeholder that `/api/model` answers before any session has reached ACP. |

The package aliases are `pnpm e2e` (`e2e-smoke.sh`), `pnpm e2e:entry`
(`e2e-entry.sh`) and `pnpm e2e:agent` (`e2e-real-agent.sh`).
