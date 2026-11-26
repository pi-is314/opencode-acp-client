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

### 2.7 `pi-acp` (pi coding agent) — passes on all three platforms

`pi-acp` (0.0.35) is an ACP adapter for `pi` (`@earendil-works/pi-coding-agent`, 1.6.1): it spawns
`pi --mode rpc` and bridges requests and events between the two. It advertises
`loadSession: true`, `promptCapabilities.image`, `sessionCapabilities {list, delete}`, and its
sessions reattach through `~/.pi/pi-acp/session-map.json`.

Measured with `pnpm e2e:matrix --agents pi` — **5 TUI builds × 3 platforms, 15/15 PASS**, every cell
reporting the real catalog `codemaker/deepseek-v4-flash` through the LAN proxy, 3 turns, history
intact: macOS 15.8.3, Debian 12, Windows 11.

**Two settings decide whether a pass means anything.** Both live in `~/.pi/agent/settings.json`:

```json
{
  "quietStartup": true,
  "defaultProvider": "codemaker",
  "defaultModel": "deepseek-v4-flash"
}
```

- **`quietStartup: true` is not cosmetic.** Without it `pi-acp` emits pi's startup banner — the pi
  version plus a line per installed skill — as the first turn's text. On this machine that was 27
  `SKILL.md` paths. A cell graded on "did text arrive" therefore PASSES while quoting paths nobody
  asked for; the matrix only noticed once the answer was read rather than counted.
- **`defaultProvider` and `defaultModel` are separate fields.** `defaultModel` is a bare model id,
  not `provider/model`. Writing `"defaultModel": "codemaker/deepseek-v4-flash"` leaves the ACP
  `model` configOption at the bundled default (`anthropic/claude-opus-5-5`), so on a machine with
  no Anthropic credential every cell dies in four seconds with no text and no tool call — while
  `pi -p … --model codemaker/deepseek-v4-flash` on the same box works, which makes it look like an
  adapter bug.

The provider itself is an ordinary OpenAI-compatible entry in `~/.pi/agent/models.json`:

```json
{
  "$schema": "https://pi.dev/schemas/models.schema.json",
  "providers": {
    "codemaker": {
      "baseUrl": "http://<gateway>/v1",
      "api": "openai-completions",
      "apiKey": "<key>",
      "models": [{ "id": "deepseek-v4-flash" }]
    }
  }
}
```

⚠️ `pi` writes its own sessions under `~/.pi/agent/sessions/`; archive them after a real-agent run
the way dsh's are archived.

### 2.6 `gemini --acp` (gemini-cli) — works everywhere, but ONLY with a settings file

★ **`gemini --acp` passes on all three platforms once `~/.gemini/settings.json` is in place.**
That file is not optional: without it the agent sends `topK: 64` from its built-in `chat-base`
preset and a gateway that caps `topK` at 40 answers

    body field generationConfig.topK must less than or equal 40

The fix is a `customAliases` entry whose `generateContentConfig` overrides it:

```json
{
  "security": { "auth": { "selectedType": "gemini-api-key" } },
  "model": { "name": "cm-gemini" },
  "modelConfigs": {
    "customAliases": {
      "cm-gemini": {
        "extends": "chat-base-3",
        "modelConfig": {
          "model": "gemini-3.1-pro",
          "generateContentConfig": { "topK": 40 }
        }
      }
    }
  }
}
```

Measured, one cell of `pnpm e2e:matrix --tui 2.4.1 --agents gemini` per platform:

| platform | gemini-cli | `~/.gemini/settings.json` | result |
|---|---|---|---|
| macOS 15.8.3 | 0.71.1 | yes | **PASS** |
| Debian 12 | 0.70.0 | yes (written during this run) | **PASS** |
| Windows 11 | 0.71.1 | yes (written during this run) | **PASS** |
| Windows 11 | 0.71.1 | **no** | BLOCKED, the `topK` 400 above |

**Check this file first whenever a gemini cell comes back BLOCKED.** It is the agent's own
configuration, not the bridge's: the bridge sends `session/set_config_option` exactly as ACP
defines it, and the agent chooses what to put in the request body.

★ A correction worth recording: an earlier revision of this page claimed the ACP path **ignores**
`customAliases` and applies only the built-in preset. That was wrong — it was inferred from a
bundle fragment that walks `customAliases` to collect valid model NAMES, which is a different use.
The alias does apply under ACP; the failures were a missing file on Linux/Windows and a stale
gateway on macOS.

#### The "20% flaky" report was two mistakes in our own test, not the agent

For a while gemini cells failed roughly one run in four — the same rate on all three platforms,
with the same TUI build sometimes passing and sometimes not. It looked like a startup race, then
like a gateway that dropped `topK`. Both readings were wrong.

What the ACP frames actually showed: gemini-cli **begins a turn by calling an internal
bookkeeping tool** (`update_tactical_intent`, `update_topic`) and, some of the time, ends the
turn there **without ever emitting `agent_message_chunk`**. The turn ran; the tool executed; the
row completed with `time.completed` set and a `tool` part and no text.

Two things in `scripts/e2e-matrix-real.mjs` then turned that into a red cell:

1. **The prompt was ambiguous.** `"In one short sentence: what is a protocol?"` was read as an
   instruction about the session itself about a quarter of the time — the model called
   `update_topic` with the question as the topic. Now it asks for a token to be echoed.
2. **The grading counted text as the only output.** An empty `text` was graded `FAIL` even when
   a tool had run. `rows()` carries a `tools` count now: turn 1 passes on text **or** a tool
   call, and turns 2/3 — which exist to prove recall — report `UNKNOWN` rather than `FAIL` when
   the model said nothing.

Measured after both changes: **10 runs, 9 PASS / 1 UNKNOWN / 0 FAIL** (was 6 PASS / 2 FAIL).

★ The lesson generalises: a cell that fails intermittently *and* passes after unrelated changes
is a signal about **the test**, not the agent. Read the ACP frames before blaming the transport —
`tool_call` frames on the wire said exactly what happened, and the failure log (HTTP polling
only) said nothing.

★ Also needed on every platform: `NO_PROXY` for the gateway's host, `GOOGLE_GEMINI_BASE_URL`
pointing at `<gateway>/antigravity`, a 36-character `GEMINI_API_KEY`, and — for headless runs —
`GEMINI_CLI_TRUST_WORKSPACE=true`, without which the agent refuses an untrusted directory.

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
