# Changelog

> [中文版](CHANGELOG.zh.md)

Every release, newest first. The project's own rules — what has been measured, what is deliberately
deferred — live in [AGENTS.md](AGENTS.md) and [docs/](docs/); this file is for readers who want to
know what changed.

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
