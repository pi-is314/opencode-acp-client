# What each agent's missing capabilities cost you here

> 中文版：[AGENT-CAPABILITIES.zh.md](AGENT-CAPABILITIES.zh.md)

> This page records **measured agent capabilities** and the **user-visible consequences** they
> have in this project. The general degradation rules are in [ACP-COMPAT.md](ACP-COMPAT.md); the
> protocol method list is in [ACP-MATRIX.md](ACP-MATRIX.md); the session machinery (two ids,
> three resume paths) is in [SESSION-LIFECYCLE.md](SESSION-LIFECYCLE.md).

## 0. How to read it (evidence levels)

| Level | Meaning |
|---|---|
| **①** | **Measured here**: the agent was started on this machine, `initialize` was sent, and `agentCapabilities` was read back |
| **②** | **Published source**: the agent's published source was read (a checkout or unpacked package on this machine) |
| **③** | **A survey says so**: only external research claims it; **not re-checked here** |

A cell with no level is **①**. **Capabilities are negotiated, not constant** — an agent upgrade changes them, so re-measure after one.

## 0.5 Identify an agent by `agentInfo`, not by its profile name

dsh's ACP entry point is the built-in ACP app (`@deepseek-ai/dsh-acp-app`), `dsh --profile acp` on
the command line. A profile name can be renamed, deleted, or pointed at another implementation.
**The identity is the `agentInfo` (name + version) and `agentCapabilities` that `initialize`
returns**, not the profile name on the command line.

| agent (identity) | Package / source | `agentInfo` | End-to-end coverage |
|---|---|---|---|
| dsh built-in ACP | `@deepseek-ai/dsh-acp-app` | whatever the agent reports in `initialize` | ✅ full `e2e:dsh-acp` run, repeatedly |
| opencode | the official `opencode acp` subcommand | `OpenCode 2.0.32` | 🟡 initialize, TUI probes, frames; real-model turn pending |
| claude | `@agentclientprotocol/claude-agent-acp` | `0.93.0` (title: Claude Agent) | ⬜ **initialize only** |
| codex | `@agentclientprotocol/codex-acp` | `2.2.2` (title: Codex) | ⬜ **initialize only** |

## 1. The capability table

| capability | dsh built-in ACP | opencode acp | claude-acp | codex-acp |
|---|---|---|---|---|
| `loadSession` (replay history on resume) | **✗** | ✓ | ✓ (①, e2e pending) | ✓ (①, e2e pending) |
| `sessionCapabilities.resume` | ✓ | ✓ | ✓ | ✓ |
| `sessionCapabilities.list` (discover old sessions / titles) | ✓ | ✓ | ✓ | ✓ |
| `sessionCapabilities.close` | ✓ | ✓ | ✓ | ✓ |
| `sessionCapabilities.delete` | **✗** | ✓ | ✓ | ✓ |
| `sessionCapabilities.fork` | ✗ | ✓ | ✓ | ✓ |
| `sessionCapabilities.additionalDirectories` | ✗ | ✓ | ✓ | ✓ |
| `promptCapabilities.image` | **✗ (explicitly false)** | ✓ | ✓ | ✓ |
| `promptCapabilities.embeddedContext` | **✗ (explicitly false)** | ✓ | ✓ | ✓ |
| `session/set_config_option` (switch model) | ✓ | ✓ | ✓ | ✓ |
| `session_info_update` (agent renames a session) | **✗ (0 times measured)** | **✗ (② source)** | ✓ (③) | ✓ (③) |
| `session/list` entries carry `title` | **✗ (no title)** | ✓ (② `withTimestampedFallback`) | unconfirmed | unconfirmed |
| auth methods | none (`authMethods: []`) | `opencode auth login` | `auth.logout` (login is its own channel) | `api-key` / `chat-gpt` |

In one sentence: **dsh's built-in ACP lacks the three big ones (`loadSession`, images, titles)**;
opencode v2 has the fullest surface. claude and codex have had their **initialize** read back, but
end-to-end (a real turn, the TUI, resume) is not yet verified.

## 2. Agent by agent: what you lose here

### 2.1 dsh built-in ACP (`@deepseek-ai/dsh-acp-app`)

```bash
oc-acp-client -- dsh --profile acp      # the profile name is a local example
```

| Missing capability | What it costs you here |
|---|---|
| `loadSession` | **The resume works but shows no history**: `-s` takes `session/resume` (reconnect the same session, no replay), the tab **keeps the real name** (no marker), and the transcript gains a `◈ Notice`: **`Resumed without showing history: this agent "<agent command>" has no session/load capability`**. Whether the context survived is **not guaranteed** — measured both ways on one profile (remembered once after a model switch, not the next time). |
| Titles | It pushes no `session_info_update`, and its `session/list` entries carry no `title` → the title can only be **derived from the first prompt** (which is written to the map, so a resume still shows the real name; a session with no prompt gets the directory name). |
| `promptCapabilities.image` / `embeddedContext` | Image and embedded-context blocks are **dropped and logged**; the text is still sent. |
| `sessionCapabilities.delete` | Deleting in the TUI only removes the local side (map entry + tab); **the agent's session stays**. The bridge tries one `session/delete` in the background; this agent may not even answer, and the timeout logs `agent could not release <id>`. |
| fork / additionalDirectories | Absent; the bridge does not announce them either, so nothing is lost on screen. |


### 2.2 opencode acp

```bash
oc-acp-client -- opencode acp
```

| Capability | What it costs you here |
|---|---|
| `loadSession` ✓ | **Resuming replays the history** — the old conversation is on screen, the opposite of what dsh's built-in `acp` gives you. |
| `session/list` with a title ✓ | The title comes from the list's `title` (`applyBackendTitle`), even when the agent pushes no `session_info_update`. |
| image / embeddedContext ✓ | Attachments and embedded context work. |
| delete / fork / close ✓ | Deleting really reaches the agent side (fork is still limited by the bridge's rule against calling unstable methods). |
| usage | Only the **unstable `usage` in the prompt result** is sent, never `usage_update`; the bridge reads both (see ACP-MATRIX §4). |


A trap on the agent's side, not the bridge's: the `opencode acp` subcommand **has no provider
credentials of its own**, so a turn fails until `opencode auth login` has been run. The error is
carried to the screen as-is.

### 2.3 claude-acp (initialize only, e2e pending)

```bash
oc-acp-client -- npx -y @agentclientprotocol/claude-agent-acp
```

- **initialize measured** (`agentInfo 0.93.0`): announces `loadSession` / `resume` / `list` /
  `close` / `delete` / `fork` / `additionalDirectories` / `systemPrompt` / `image` /
  `embeddedContext` / `auth.logout` / `mcp http+sse`.
- Titles: reported to send `session_info_update` (③, not re-checked here).
- **End-to-end (real turn, TUI, resume) is not fully verified**: the above says "it announces
  this", not "it works in this project". Pending:
  `AGENT="npx -y @agentclientprotocol/claude-agent-acp" bash scripts/e2e-real-agent.sh` plus one
  real TUI turn.

### 2.4 codex-acp (initialize only, e2e pending)

```bash
oc-acp-client -- npx -y @agentclientprotocol/codex-acp
```

- initialize measured (`agentInfo 2.2.2`): equally complete (plus a `subagents` variant). It
  deliberately does **not** send `current_mode_update` (it uses `config_option_update`); this
  bridge handles both, so it makes no difference.
- Auth: both `api-key` and `chat-gpt`.
- **End-to-end not fully verified** (same as above).

### 2.5 `agy acp` (Antigravity) — macOS yes, Linux blocked inside the agent

`agy acp` completes a 3-turn conversation on **macOS** (5/5 TUI versions, `gemini-3.1-pro-low`).
It needs three variables pointing at a gateway — `NO_PROXY`, `GOOGLE_GEMINI_BASE_URL=<host>/antigravity`
and a 36-character `GEMINI_API_KEY` — **plus `modelProvider: "gemini"` in
`~/.gemini/antigravity-cli/settings.json`**. Without the settings key it authenticates against
Google instead and answers `Authentication required` at `session/new`.

**Linux works too, 5/5** — but only when the requests are serialised. `agy` handles
`initialize` and `session/new` CONCURRENTLY (`ACP Request received: session/new` arrives before
`initialize` has finished booting the backend), and a `session/new` that lands during boot is
cancelled: the log reads `Booting backend`, then
`failed to create conversation: canceled: context canceled`. A hand-written probe that pipes both
JSON frames into stdin at once therefore reproduces a failure that the bridge never triggers —
`AcpClient` awaits `initialize()` before `newSession()`. Measured: the same probe writing
`session/new` only after the boot log appears answers `{"id":2}` exactly like macOS.

On Linux it also needs `~/.gemini/antigravity-cli/settings.json` (`modelProvider: "gemini"`) and a
gateway that actually serves `/antigravity` — the Linux box's `codemaker-hub` on port 12300 does
(`/v1/models` and `/antigravity` both answer there; a probe against the wrong port returns 404 on
`/antigravity` while `/v1/models` still says 200, which reads like "no antigravity here").

### 2.6 `gemini --acp` (gemini-cli) — the ACP path ignores `customAliases`

Measured on gemini-cli 0.71.1 against the same gateway. The failure is a 400:

    body field generationConfig.topK must less than or equal 40

★ **The cause is in gemini-cli, and it is a CLI/ACP divergence.** The gateway caps `topK` at 40,
gemini-cli's built-in `chat-base` preset hard-codes 64, and the documented workaround —
`modelConfigs.customAliases` with `generateContentConfig: {topK: 40}` — **works in CLI mode and is
ignored in ACP mode**:

| mode | command | result |
|---|---|---|
| CLI | `gemini -m cm-gemini -p "say hi"` | ✅ answers |
| ACP | `gemini --acp` → `session/new` | ✅ returns `models.currentModelId: "cm-gemini"` … |
| ACP | … then a prompt | ❌ 400 `topK` |

The bundle makes it explicit (`bundle/chunk-5XMSOGIG.js`): the ACP server walks
`modelConfigs.customAliases` **only to collect the alias NAMES into `validModels`** — it never
applies the alias's `modelConfig`. So the name is accepted while the parameters stay at the
built-in preset. Nothing on this side can fix that: the bridge sends `session/set_model` /
`session/set_config_option` as ACP defines them and the agent does the rest.

Practical workaround until upstream changes it: use `agy acp` for Gemini under ACP (it applies its
own config), or point gemini-cli at a gateway that accepts `topK: 64`.

## 3. The general mapping: lose a capability, see what

| agent lacks | still works | example |
|---|---|---|
| `session/load` | resume (same session, context **may** continue) | dsh built-in ACP |
| `resume` as well | new sessions still work | fake agent fixture |
| titles (`session_info_update` and list `title`) | sessions work | dsh built-in ACP |
| `promptCapabilities.image` | text prompts | dsh built-in ACP |
| `promptCapabilities.embeddedContext` | text prompts | dsh built-in ACP |
| `sessionCapabilities.delete` | deleting the local tab | dsh built-in ACP |
| `sessionCapabilities.close` | the session works | not measured |
| `sessionCapabilities.list` | the session works | fake agent |
| `session/set_config_option` | the default model | not measured |

## 4. Check it yourself (one command, no code changes)

```bash
# replace <agent command> with any row above to read back its agentCapabilities
python3 - <<'PY'
import json, subprocess
cmd = ["dsh", "--profile", "acp"]          # e.g. ["opencode", "acp"]
p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                     stderr=subprocess.DEVNULL, text=True, cwd="/tmp")
p.stdin.write(json.dumps({"jsonrpc":"2.0","id":1,"method":"initialize",
                          "params":{"protocolVersion":1,"clientCapabilities":{}}}) + "\n")
p.stdin.flush()
print(json.dumps(json.loads(p.stdout.readline()), indent=2, ensure_ascii=False))
p.kill()
PY
```

Read `result.agentInfo` and `result.agentCapabilities` (`loadSession`, `promptCapabilities`,
`sessionCapabilities`). **Check `agentInfo` first** to be sure which agent you are talking to —
the profile name is not reliable.

For the end-to-end layer (real terminal, real turn, assertions on screen):

```bash
bash scripts/e2e-agent-matrix.sh     # six agents, one full turn each; an agent's own credentials are BLOCKED, not failed
```

★ The `[acp] initialized: {…}` line in the bridge log is **the ground truth for the capability
matrix** — when "some feature does nothing", read it before guessing, and before grepping another
project's source.
