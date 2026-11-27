# Changelog

> [中文版](CHANGELOG.zh.md)

Every release, newest first. The project's own rules — what has been measured, what is deliberately
deferred — live in [AGENTS.md](AGENTS.md) and [docs/](docs/); this file is for readers who want to
know what changed.

---

## v0.3.0

### Highlights

#### ACP mode switching

`Shift+Tab` and `/agents` now switch the ACP agent's own modes (`plan`, `accept-edits`, `auto`,
`yolo`, …) instead of doing nothing. `agy acp` starts in `default` and used to ask permission for
every tool call with no way out; `claude`, `codex`, `opencode acp` and `gemini --acp` all expose
modes too. The selection is remembered per session, so `-c`, `--session` and reopening a tab put
you back in the mode you left (PR #4, by [@poppyer9](https://github.com/poppyer9)).

Both ACP surfaces are supported — `configOptions` and the older `SessionModeState` — and
`configOptions` wins when an agent advertises both, which is what the spec says is coming.

#### pi + pi-acp, measured on all three platforms

[pi](https://github.com/badlogic/pi-mono) through the [pi-acp](https://github.com/svkozak/pi-acp)
adapter is now in the matrix: **5 TUI builds × macOS 15.8.3 / Debian 12 / Windows 11, 15/15 PASS**.

#### Usage accounting stops losing turns

`PromptResponse.usage` is the agent's per-turn total. It was being emitted verbatim, so
`session.get().tokens` fell back to whichever of two consecutive turns was smaller, and a mid-turn
`usage_update` (with output and cache zeroed) wiped the accumulated cache reads. Totals accumulate
now. Turns that exceeded the context window are no longer dropped — they used to vanish from the
usage plugins entirely. The documented cost: the built-in context meter can read past 100% until a
smaller turn settles (PR #5, by [@poppyer9](https://github.com/poppyer9)).

#### Files you `@`-mention are forwarded

Picking a file or a directory from the TUI's `@` menu used to fail with `400 attachment not
supported` — which also made a home-screen submit read as "Failed to create session". Non-image
`file://` URIs now travel as ACP `resource_link` blocks, which every agent must accept (PR #6, by
[@poppyer9](https://github.com/poppyer9)).

#### A cold `GET /api/agent` answers with real modes

It used to fall back to a synthetic primary agent until some session happened to be warm, so a
freshly started client saw no modes at all (PR #4).

### Fixed

- **A restored session no longer spins on a tool-only reply**: some agents open a turn with an
  internal bookkeeping tool and end it there; the matrix now counts that as a turn rather than a
  failure.
- **`/api/project` and `/api/location` carry `worktree`**, which is what opencode desktop groups
  sessions by.

### Verified

| Platform | The gate | Real-agent matrix |
|---|---|---|
| macOS 15.8.3 | ✅ | 5 builds × 8 agents |
| Debian 12 | ✅ | **40/40 PASS** |
| Windows 11 | ✅ | 39 PASS / 1 UNKNOWN |

480 unit tests, 0 skipped.

---

## v0.2.1

### Fixed

- **A restored session no longer spins forever.** `usage_update` and `session_info_update` frames
  arriving after a `session/load` were treated as conversation output, which opened a turn that
  nothing would ever close. Only real agent output starts one now (PR #3, by
  [@poppyer9](https://github.com/poppyer9)).
- **The model catalog is announced when it finally arrives.** `/api/model` could answer the
  `acp/default` placeholder while a `session/load` was still in flight; the catalog is now
  announced after every path that can produce one.
- **`/api/command` no longer replays every remembered session** in the directory to discover the
  agent's slash commands — it starts one.
- **Replayed transcripts keep their tool results**: failed and cancelled historical calls render as
  errors, and replayed reasoning carries a time instead of spinning.

---

## v0.2.0

### Highlights

#### Windows works now

1. **Every launch rule lives in one place**: `.mjs` / `.cmd` / `.bat` script files, a bare command
   name resolved through `PATHEXT`, and images used as given. `agent command not found: node` was
   the `PATHEXT` gap; `spawn EFTYPE` was a script file handed to `spawn` directly.
2. **`pnpm verify:win`**: the same gate through a Windows door — typecheck, the unit suite, the
   e2e smoke run, and the protocol round-trip.
3. **Nine Windows unit failures, two JSON-escaping assertions, and a `--help` that lost its whole
   forwarded-flags section** (opencode answers with CRLF there, and npm installs it as a `.cmd`
   that `execFileSync` cannot launch).

#### The official ACP SDK

1. **No hand-written wire protocol** — it rides `@agentclientprotocol/sdk`.
2. **Every frame is validated against the published schema** (`tests/acp-schema.test.ts`), so a
   misspelled field fails in the suite instead of at the first real agent.

#### Thinking and reasoning effort are wired through

1. **`/thinking`'s `model.variant` now reaches the agent's effort option.**
2. **The effort option an agent reports shows up in the picker.**
3. ★ Recorded because it cost a day: **dsh's official `acp` profile names that option
   `reasoning_effort`**, not `effort`.

#### Double-Esc now really stops the turn

Pressing Escape twice used to leave the spinner running. The root cause was a
`session.tool.failed` carrying an empty `content: []`: the client rewrites tool content on
v2.3+, threw on the empty array, and swallowed the interrupt event behind it.

#### Session history and resume

1. **A restored session keeps its historical timestamps** (PR #2, by
   [@poppyer9](https://github.com/poppyer9)) — old conversations no longer pile up under "Today".
2. **The model list refreshes after a resume**, so the footer and the transcript cards agree.
3. **The agent's own private sessions are no longer imported as `ses_acp_…` ghost tabs.**

#### A nicer exit wordmark, and a logo

The wordmark gained the four letters it never had (`a`, `i`, `l`, `t`), and the project has a
`logo.png` / `logo.svg` generated from the same glyph tables (`scripts/make-logo.py`).

#### Real-agent coverage for `agy acp` and `gemini --acp`

The matrix now drives seven agents instead of five.

### Verified

| Platform | The gate | Real-agent matrix |
|---|---|---|
| macOS | ✅ | 34 passed / 1 blocked |
| Linux (Debian 12) | ✅ | 30 passed / 5 blocked |
| Windows 11 | ✅ | 30 passed / 5 blocked |

The matrix is **5 TUI versions × 7 agents** (`opencode acp`, `claude`, `codex`, `qwen`, `dsh`,
`agy`, `gemini`), three real turns per cell.

- **`agy acp`** passes on all three platforms.
- **`gemini --acp`** is BLOCKED in every cell, and the cause is gemini-cli: the gateway caps
  `topK` at 40 while its built-in `chat-base` preset hard-codes 64, and the documented
  `customAliases` workaround **works in CLI mode and is ignored in ACP mode** — the bundle walks
  `modelConfigs.customAliases` only to collect the alias NAMES into `validModels`, never applying
  the alias's config. Details in [docs/AGENT-CAPABILITIES.md](docs/AGENT-CAPABILITIES.md).

### Upgrading

- **No breaking changes.** `~/.opencode-acp-client/sessions.json` keeps its schema, and the
  environment variables are still `OPENCODE_BIN` plus `OPENCODE_ACP_CLIENT_*` — **no aliases**.

---

## v0.1.0

First published version: the opencode v2 TUI driving any ACP agent, with one ACP connection per
agent program and sessions multiplexed over it.
