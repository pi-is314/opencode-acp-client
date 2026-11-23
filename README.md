# opencode-acp-client

> 中文版：[README.zh.md](README.zh.md)

> **Not built by the OpenCode team and not affiliated with them in any way.** This is a
> community-maintained project. "opencode v2" here names the open-source opencode v2 TUI this
> project drives — you install and run it yourself as a separate program; this project neither
> bundles it nor speaks for it.

Use the **opencode v2 TUI** as the interface, driving **any ACP agent** (a terminal
**[ACP](https://agentclientprotocol.com) client**).

```
opencode v2 TUI ──HTTP + SSE──▶ opencode-acp-client ──ACP stdio──▶ any ACP agent
   (the interface)
                                  (the ACP client)
                                                                   dsh --profile acp /
                                                                   opencode acp / qwen --acp /
                                                                   claude-acp / codex-acp …
```

**Who it is for**: people who like the opencode v2 TUI — who have learned its keybindings, its
command palette, its session tabs — and want to keep using that interface while driving an agent
that is **not** opencode's own.

## Install

### 1. Install opencode v2 first

This tool **does not ship the TUI**; it drives an **opencode v2** you install yourself
(`>=2.0.0`; the latest release is recommended). **Skip this step if you already have it** (confirm
with `opencode --version` — it must be v2.x); otherwise, any one of:

```bash
curl -fsSL https://opencode.ai/v2/install | bash   # the official install script
npm install -g @opencode/cli                      # or npm (the package is @opencode/cli)
```

Check it: `opencode --version` must print **v2.x**. v1 will not do — it speaks a different event
vocabulary, and this tool refuses to start against it.

### 2. Install this tool

Needs **Node ≥ 20**.

```bash
# Option 1: from npm (recommended — you get a prebuilt package)
npm install -g opencode-acp-client

# Option 2: straight from source (point at the Git repository; npm fetches and builds it)
npm install -g git+https://github.com/pi-is314/opencode-acp-client.git
```

Both give you exactly the same thing. Option 2 bypasses the npm registry — useful to track the
main branch, or when the registry is not an option — and it compiles once at install time with
`typescript` (a dozen seconds or so), so it needs registry access to fetch the compiler.

Two command names are installed, pointing at the same entry: **`opencode-acp-client`** (the
primary name) and **`oc-acp-client`** (a short alias).

When the TUI is not on `PATH`, point at it with `$OPENCODE_BIN`; the version is checked at
startup and reported rather than guessed.

## Use

```bash
npm install -g opencode-acp-client

oc-acp-client -- dsh --profile acp     # dsh's built-in ACP profile
oc-acp-client -- qwen --acp            # qwen-code
oc-acp-client -- opencode acp          # our bridge turns `opencode acp` back into opencode's own http protocol :)
```

The command after `--` is the agent; anything that speaks ACP over stdio works. One command
starts the TUI plus the adapter layer; quitting the TUI (or Ctrl-C) stops the agent too, leaving
no stray processes.

Beyond those, plenty of other agents implement ACP — for example
[gemini-cli](https://github.com/google-gemini/gemini-cli) (`gemini --acp`),
[Pi](https://github.com/badlogic/pi-mono) (through the [pi-acp](https://github.com/svkozak/pi-acp) adapter),
[GitHub Copilot](https://github.com/features/copilot),
[Kimi CLI](https://github.com/MoonshotAI/kimi-cli),
[Goose](https://block.github.io/goose/), [Cursor](https://cursor.com/docs/cli/acp),
[Kiro CLI](https://kiro.dev/docs/cli/acp/), [Cline](https://cline.bot/),
[OpenHands](https://docs.openhands.dev/openhands/usage/run-openhands/acp), and more.
**More ACP agents are listed here**: <https://agentclientprotocol.com/get-started/agents>.

**Resuming a session:**

```bash
opencode-acp-client -c                  # the most recent one in this directory
opencode-acp-client -s ses_xxxxx        # a specific session
```

`-s` / `-c` do **not** accept an agent command — which agent to use comes from the session map,
and the CLI starts it for you. Where do ids come from? The `Continue` line printed when the TUI
exits has been rewritten into a command you can paste; alternatively:

```bash
python3 scripts/list-sessions.py            # the newest 20: id, age, title, directory
python3 scripts/list-sessions.py my-project # filter by title/directory/id substring
```

**One client serves one agent.** That is by design, not a gap: the model/provider belong to the
agent, and mixing two agents' tabs into one TUI is exactly where "the new tab shows the other
agent's models" came from. So the TUI's tab layout is isolated per agent
(`~/.opencode-acp-client/opencode/<agent-slug>/`), and a session belonging to another agent is
refused (`404`). `--` is for a **new** session only.

## Agents measured here

Every row is a real run, not copied from documentation.

| Agent | Command |
|---|---|
| dsh (built-in ACP profile) | `dsh --profile acp` |
| opencode | `opencode acp` |
| [qwen-code](https://github.com/QwenLM/qwen-code) | `qwen --acp` |
| [claude-acp](https://github.com/agentclientprotocol/claude-agent-acp) | `npx -y @agentclientprotocol/claude-agent-acp` |
| [codex-acp](https://github.com/agentclientprotocol/codex-acp) | `npx -y @agentclientprotocol/codex-acp` |

## Common options

| Option | Meaning |
|---|---|
| `<directory>` | the working directory (opencode's spelling; `--directory` / `-C` also forward to the TUI) |
| `-s <id>` / `--session <id>` | resume that session |
| `-c` / `--continue` | resume the most recent session in this directory |
| `--no-tui` | serve the HTTP/SSE surface only, without the TUI |
| `--bridge-port <n>` | serve on this port only (implies `--no-tui`) |
| `--bridge-log <path>` | where the bridge log goes |
| `$OPENCODE_BIN` | the opencode v2 binary |

**These are the only options that reach the TUI** (with opencode v2's own semantics, not ours):

| Option | How it reaches the TUI |
|---|---|
| `--auto` | forwarded verbatim (auto-approve permissions that are not explicitly denied) |
| `--prompt <text>` | forwarded verbatim (prefill the composer) |
| `--print-logs` | forwarded verbatim |
| `--log-level <level>` | forwarded verbatim |
| `-c` / `--continue` | forwarded verbatim — the TUI reads its own remembered session list |
| `-s <id>` / `--session <id>` | **the bridge resolves it first**: it accepts the `ses_…` you were shown, then hands the TUI a `--session` |

`--server` / `--standalone` are ours (the bridge *is* that server) — they are dropped, **not**
forwarded. Nothing else goes to the TUI: subcommands like `auth`, `plugin` and `upgrade` pass
straight through to the opencode **binary** instead (see below).

`--help` prints opencode v2's own help first, then this tool's section.

**Subcommands**: `models` / `api` / `session` go through the bridge (the answer belongs to the
agent you attached); the rest (`auth`, `plugin`, `upgrade`, `debug`, …) pass straight through to
opencode. `ps` lists the bridge processes this tool has started.

## Files it writes

All under `~/.opencode-acp-client/`. It **never writes into a native opencode v2 install**; the
session map stores ids, directories, titles and the agent's argv — **no message content and no
credentials**.

| Path | What it is |
|---|---|
| `sessions.json` | the session map (visible id ↔ the agent's own id, directory, title, agent) |
| `opencode/<agent-slug>/` | that agent's TUI state and data; config (`tui.json`, plugins, themes) is shared with your own install |
| `daemons/<pid>.json` | the registry `ps` uses; removed on a clean exit |

## What a resumed session looks like

It depends on which capability the agent announces — the tab title tells you which case you are in:

- It has `loadSession` → history is replayed; you see the original conversation.
- Only `sessionCapabilities.resume` (dsh's built-in `acp` profile is like this) → ACP's
  `session/resume` **does not replay history by spec**, so the tab is empty, but it keeps the
  real name and carries a `◈ Notice` explaining why. **Whether the context survived is not
  guaranteed by the spec.**
- Neither → the old session cannot be reattached; the tab becomes a **new conversation** titled
  `[new conversation] <directory name>`.

## Platforms and versions measured

The **whole gate** (typecheck, unit tests, the 52-probe OpenAPI check, and every real-TUI mode in
tmux) has run on **macOS** and on **Debian 12**: **v2.0.0, v2.1.0, v2.2.0, v2.3.0** on both,
plus intermediate releases such as v2.2.7 on macOS. Windows runs typecheck and the unit tests;
its TUI is not measured (no tmux). Sixteen releases are recorded one row each in
[docs/COMPAT-OPENCODE.md](docs/COMPAT-OPENCODE.md).

## Design rules

1. **Every inbound request gets an answer.** An agent that asks something and hears nothing back
   waits forever; anything we do not support is refused explicitly so the agent can degrade.
2. **Never assume a capability exists.** ACP is negotiated; the degradation rules are in
   [docs/ACP-COMPAT.md](docs/ACP-COMPAT.md).
3. **Prefer a noisy truth to a quiet guess.** A gap must be discoverable, not silently rendered
   as nothing.

## Known gaps

- Unimplemented routes: pty, MCP auth, provider OAuth, worktree changes, revert/share, most of
  `/tui/*` — they answer with a well-formed empty envelope, or a logged 404. The 355 requests a
  real session makes are all covered.
- **Other v2 clients are not recommended yet**: the state roots are injected into the TUI child
  we spawn ourselves, and no other client can be given them, so its tabs are not isolated per
  agent (see above).

## Docs

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — the process model and one turn end to end
- [docs/PROTOCOL.md](docs/PROTOCOL.md) — the opencode v2 surface we implement
- [docs/ACP-MATRIX.md](docs/ACP-MATRIX.md) — the ACP method matrix, event variants, deliberate deviations
- [docs/ACP-COMPAT.md](docs/ACP-COMPAT.md) — the runtime capability degradation rules
- [docs/COMPAT-OPENCODE.md](docs/COMPAT-OPENCODE.md) — version policy and the per-release record
- [docs/SESSION-LIFECYCLE.md](docs/SESSION-LIFECYCLE.md) — sessions, the map, the resume paths
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) — development notes and the traps
- [AGENTS.md](AGENTS.md) — the entry point for developing this repository

## License

[Apache-2.0](LICENSE). This project launches the opencode v2 binary as a separate process and
talks to its published HTTP API; it **links no third-party source**, so the licence stands on its
own.
