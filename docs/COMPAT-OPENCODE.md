# opencode v2 compatibility

> 中文版：[COMPAT-OPENCODE.zh.md](COMPAT-OPENCODE.zh.md)

## The policy

**opencode >= 2.0.0.** Declared in `package.json` (`opencodeVersion`), enforced by
`src/opencode-bin.ts` (`MIN_MAJOR_VERSION`), asserted by
`tests/version-policy.test.ts`, and held to a real binary by
`scripts/check-opencode-version.sh`.

The gate is a **major** check, and only that: within v2 the surface we serve has
been additive so far, and a minor-version whitelist would reject new releases for
no measured reason. What it does catch is v1, which speaks an entirely different
event vocabulary — the failure mode there is a silent, empty TUI, so a released
minor is a much better trade than a silent one.

| | |
|---|---|
| Declared range | `>=2.0.0` |
| Rejected | v1 (different event vocabulary), and anything unparseable |
| CLI surface | `opencode --server <url>` (v2). v1's `opencode attach` is *not* what this drives |
| Enforced fatally | when we launch the TUI ourselves (the default) |
| Enforced as advice | with `--no-tui` (see [DEVELOPMENT.md](DEVELOPMENT.md)): the TUI may be started separately, so a missing or v1 binary is a warning, not a failure |

## Versions verified

| opencode v2 | Date | What was run |
|---|---|---|
| **2.0.0 / 2.1.0 / 2.2.7** | 2026-11-13 | The boundary matrix, run end to end by `scripts/compat-matrix.sh` on macOS: **3 cells, 0 failed**. The point was not to re-prove HTTP (the per-release rows above do that) but to find assertions that only hold on the newest release. It found four, all ours, plus two differences that are the client's own: v2.0.0 does not group a lone `websearch` (only grep/glob count as exploration), and v2.0.0's `/timeline` **kills the TUI** (v2.2.7 moved that view into a plugin). |
| `v2.3.0` | 2026-11-14 | 139 → 139 routes, 498 → 500 schemas, **nothing removed**: `experimental.mcp.event` (we do not implement MCP) and `session.step.first-token`, which neither `packages/tui/src` nor `packages/app/src` consumes — it is a server-side timing event, so not emitting it changes nothing on screen. **Two behaviour changes the gate tripped over, both deliberate on the client's side:** a *What's new in this release* dialog on the first launch of a version (`dialog-highlights.tsx`, Enter clears it) held the composer, so every mode waiting for input timed out; and `session.verbosity` now defaults to `low`, which collapses a run of tool calls into one activity row (`dialog-config.tsx: default: "low"`), so tool-card assertions cannot read the row. The harness dismisses the dialog inside its wait and pins `session.verbosity: "high"` through `OPENCODE_CONFIG_DIR` — note the file is `cli.json` as of this release; `tui.json` is read only to migrate. Manifest moved to 140 routes afterwards. |
| `v2.2.7` | 2026-11-11 | The whole gate, run on macOS via `--path` against the v2 installer's binary. No route diff was taken (the surface is unchanged from 2.2.6 as far as this run could see: every route the bridge serves still answered, `check-openapi.py` reported the same 32 pass / 20 note / 0 fail). **What the run did find was ours**: the rendering mode's `send_prompt` helper typed the prompt, slept 1.6s and pressed Enter, which under load sometimes landed before the composer took keystrokes — the turn never started, and the failure looked like a translation-layer regression ("every layer is missing", no session id in the log, while the bridge had in fact served session/model/agent/command). The helper waits for its own text on screen now. Fixed, then the full gate passed. |
| `v2.2.6` | 2026-11-07 | 138 → 139 routes: one experimental addition, `GET /api/experimental/job?sessionID=&kind=` listing background work (`Job.Info = Job.Shell \| Job.Subagent \| Job.Image`). Nothing removed. The rest of the diff is schema-shape churn from the generator — the `location`/`types` query parameters went from `{anyOf: […]}` to an equivalent `{type: object, properties: …}`, and the ~100 "new" schemas are the v2 events getting modelled (`Event.ID`, `session.*`, `Job.*`) where they used to be bare enum strings. **`/api/event`'s `types` enum is 96 → 96: not one event type added or removed.** None of the eight schemas the bridge consumes changed, so no code change was needed. Worth knowing: the TUI gained transcript jumps inside subagent sessions (#60817) — that is its own native-session feature, not something the ACP path can reach. |
| `v2.2.5` | 2026-10-31 | No route change since v2.2.4 (138 routes); the only addition is the `Config.Compaction.Percent` schema. Nothing the bridge serves or consumes changed. |
| `v2.2.4` | 2026-10-31 | 134 → 138 routes: four experimental `artifacts` routes (`/api/experimental/artifacts`, `/providers`, `/{artifactID}`, `/{artifactID}/view/*`) with a pluggable-provider artifact store. Nothing removed. `/api/event`'s `types` enum grew by two (`artifact.updated`, `persistent-pty.updated`) — the bridge ignores `types`, so it is unaffected. None of the eight schemas it consumes changed. Verified end to end: **`pnpm verify:version 2.2.3` passes the whole gate** (16 real-TUI modes + epilogue green). |
| `v2.2.2` | 2026-10-30 | Same 134 routes — nothing added, nothing removed; the removed schema names are inline-variant renames (`*_1`/`*_2` → `Native`). Three widenings we already tolerate: the `types` query on `/api/model` and `/api/event` now also accepts `null`, and `/api/shell`'s `timeout` gained a maximum. Two new **optional** fields to know about: `Session.Info.time.busy` (start of the most recent execution; `idle` keeps the previous execution's end while one runs) and `PromptInput.FileAttachment.source`. The bridge sends neither — `busy` is optional and behaviour is driven by `session.execution.*` events, and attachments travel as `uri` — so no change was needed; full gate green. |
| `v2.2.1` | 2026-10-29 | Diffed against v2.2.0: the HTTP surface only **grows** — 4 experimental `schedule` routes added, nothing removed, and no `session/update` variant added or dropped. The one schema change is `Model.Variant.settings` narrowing to the new `Model.VariantSettings` (with `compaction` and `encoding` added), which stays open (`additionalProperties: {}`) and still accepts the `{id}` variants the bridge publishes. `fix(tui): show execution failures that happen before any step` makes the client render an `idle` message's `error`, which the bridge already sets, so a pre-step failure now shows a row instead of nothing. No code change was needed. |
| `v2.2.0` | 2026-10-27 | HTTP surface diffed against v2.1.4: 7 routes added (`/api/experimental/usage/limits`, `/api/plugin/gui`, `/api/experimental/media/{hash}`, the `generate/*` family, `fs/watch`), 1 experimental voice route dropped, 16 schemas changed additively. The TUI now asks for usage limits on startup and v2.2 typed models (`Model.Type`, `chat` by default), so the bridge answers `/api/experimental/usage/limits` with the declared `data: null`, names every model `chat`, and honours `?types=` on `GET /api/model`. The first full run of the real v2.2 TUI then found two regressions the HTTP surface cannot show: `!command` rendered nothing (its events must carry the `evt_` prefix both client generations strip) and any failed tool crashed the TUI (a tool part's `state.error` is `{type, message}`, not a string). Both fixed and screen-verified. |
| `v2.1.0` | 2026-10-20 | Added **todo lists** (tool `todowrite` behind `experimental.todo`) and **long-request** reliability; `/api/mcp` is now read during startup. v2.1 also fixed the ACP `usage_update.used` regression: it now reports `state.usage.last`, not the turn total. Real-TUI startup on this machine exceeded the old 60/120s ceilings; raised to 180/240s. |
| `v2.0.32` | 2026-10-17 | The client auto-updated again mid-week and the gate caught it twice: once as a real failure (the single-entry mode timed out — v2.0.32 performs one more full round of server reads before the composer renders, so the e2e wait went 60s → 120s) and once as the version gate. Full `verify` green, 157 checks; `CLIENT_VERSION_HINT` raised here |
| `v2.0.31` | 2026-10-17 | The gate detected the new release the day it shipped (the TUI auto-updates itself and warned: "Server at … has version 2.0.30; this client is 2.0.31"). Full `verify` against a temp-prefix install: 156 checks passed — typecheck, 231 unit tests, 53-probe spec conformance, smoke/entry, all real-TUI modes. `CLIENT_VERSION_HINT` bumped here, so the mismatch warning is gone |
| `v2.0.30` | 2026-10-16 | The version most of this repository's week was measured on: the form-dismiss DELETE fix, the CLI three-class contract, the resume/continue rework, fs/find + image attachments — every real-TUI probe ran against it. `pnpm verify` green at 157 checks |
| `v2.0.28` | 2026-10-13 | The version the gate caught on its own: this machine's client updated to it mid-review, the real-TUI step failed because a fixed `sleep 8` typed the prompt before the composer was ready, and the step now waits for markers instead of durations. Passing: typecheck, 118 unit tests, the 43-probe spec check, the smoke and entry suites, and both real-TUI phases (per-layer screen assertions on the live and reloaded screens; Escape twice → `session.interrupt` → `200`) |
| `v2.0.27` | 2026-10-13 | `pnpm verify` against the installed binary: typecheck, 118 unit tests, the published-spec conformance check (43 probes), the 7-scenario smoke suite, the entry-point suite, and the real-TUI acceptance in tmux (session reload renders history; `Escape` twice sends `session.interrupt` and gets `200 {interrupted}`) |
| `v2.0.22` | 2026-10-13 | The same gate against a release **six versions older** than the one this repository was developed on (npm-installed into a temp prefix; the client on this machine was untouched). Everything passed: typecheck, 118 unit tests, the 43-probe spec check, the smoke and entry suites, and **both real-TUI phases** — per-layer screen assertions on the live and the reloaded screen, and Escape twice → `session.interrupt` → `200`. That is what makes this a version gate rather than a regression suite for one build |
| `v2.0.0` | 2026-10-18 | The declared floor, run in full on **macOS** and on **Linux** (Alpine/musl in Docker). It is what found the `/pair` crash: v2.0.0's screen dereferences `urls` from `GET /api/server`, which the bridge did not serve; with the route added, the whole gate is green on both platforms |

A green row means the whole gate passed against that exact binary — not that the
version is "supported in principle". Adding a row is the output of the command
below.

**Platforms.** The whole gate — typecheck, unit tests, the 52-probe OpenAPI check and
every real-TUI mode in tmux — has run on **macOS** (darwin-x64) and on **Debian 12**
(glibc, x86_64):

| version | macOS | Debian 12 |
|---|---|---|
| v2.0.0 | ✓ | ✓ |
| v2.1.0 | ✓ | ✓ |
| v2.2.0 | ✓ | ✓ |
| v2.3.0 | ✓ | ✓ |

macOS carries additional point releases (v2.2.7 and others) recorded per version above.
An earlier Linux run used **Alpine/musl** in Docker at v2.0.0; the matrix above is glibc.
On Debian the unit suite also passes when launched from **PowerShell 7.4** (`pwsh`).
Windows runs typecheck and the unit suite on `windows-latest`; its TUI is not
measured (see [Windows](#windows)).

## Verifying a version

```bash
# what you already have, without installing anything
bash scripts/check-opencode-version.sh --path ~/.opencode/bin/opencode

# a specific release: installs it under a temporary HOME (your ~/.opencode is
# untouched), then runs the whole gate against it
bash scripts/check-opencode-version.sh 2.0.27

# the newest release >= 2.0.0
bash scripts/check-opencode-version.sh latest-v2
```

`pnpm verify:version` is the same thing. The script fails if the binary reports a
major below the policy **before** it runs anything, so a mis-resolved download
cannot quietly turn into a green run of the wrong thing.

The gate includes the **real TUI**: `scripts/e2e-real-tui.sh` drives it in tmux against
the fake agent through a rich turn (reasoning, a tool call with input and output, a
reply) and asserts what is *on the screen* — the user row, the thinking block, the tool
card, the reply, and the agent/model footer — rather than what we sent. Each captured
screen is written to `.artifacts/`, so a version's rendering can be inspected (and
diffed against the next version) instead of merely trusted. That is the part a unit test
cannot do, and the reason a new release is judged by its screen.

## Watching releases

`.github/workflows/opencode-release.yml` runs daily (and on `repository_dispatch`
and `workflow_dispatch`): it resolves the newest release tag, installs exactly
that version, and runs `pnpm verify` through the script above. A failure opens an
issue — a broken release is news about opencode v2, not about this commit.

The workflow's `repository_dispatch` branch takes the version from
`client_payload.version`, so a relay can hand it the exact tag. Upstream releases
cannot trigger this repository directly (a `release` event only fires for releases
of the repository it lives in), so a relay polls the release **atom feed** and fires
the dispatch — or runs the gate locally, on a machine where the TUI can run:

```bash
# every 30 minutes, dispatch to CI when a new v2 tag appears (needs gh + a token)
bash scripts/watch-opencode-releases.sh --interval 1800 --dispatch --notify

# one shot for cron/launchd; --run gates locally instead of dispatching
bash scripts/watch-opencode-releases.sh --once --run
bash scripts/watch-opencode-releases.sh --once --dry-run   # what would it do?
```

The watcher reads the atom feed (no API quota, no rate-limit failure mode), ignores
pre-releases and anything outside `2.x`, keeps a `seen` tag under
`~/.opencode-acp-client/`, and **does not advance it when the gate fails**, so the
next run retries. A lock stops two watchers (or a watcher and a manual gate) from
driving two TUIs on one machine. A macOS `launchd` or `cron` entry can run the
`--once` form; the log is `~/.opencode-acp-client/opencode-release-watch.log`.

```cron
# hourly is plenty; a full run downloads ~200 MB
17 * * * * cd /path/to/opencode-acp-client && bash scripts/watch-opencode-releases.sh --once --dispatch --notify >> /tmp/opencode-watch.log 2>&1
```

Versions are resolved from the **npm registry** (`@opencode/cli`), which is the
channel v2 itself publishes to, needs no token, and has no quota; the releases
atom feed is the fallback. Three traps are worth recording, because each cost a
debugging round:

- The GitHub **API rate-limits** an unauthenticated host, and a rate-limited
  watcher sees "no releases" and stays green forever.
- `https://opencode.ai/install` (no `/v2/`) is the **v1 installer**: it resolves
  `latest` for the v1 line, and its release assets do not exist for v2 — it fails
  with an `unzip` error rather than a clear "wrong channel". The v2 channel is
  `https://opencode.ai/v2/install`, and `npm install -g @opencode/cli@<version>`
  is the plainest of all.
- Both installers hard-code `INSTALL_DIR=$HOME/.opencode/bin`, so a version check
  that installed naively would overwrite the developer's own binary. This script
  installs into a temporary npm prefix instead.

CI needs: node, pnpm, `tmux` and `zsh` (the real-TUI acceptance drives the TUI in a
login shell), and `python3` +
`jsonschema` (the spec check). `scripts/e2e-real-agent.sh` is deliberately not part
of the gate — it needs a real ACP agent installed, so it is an occasional check
rather than a gate.

## What this does not cover

- **A different platform.** The CI job runs on Linux; the TUI's rendering is
  terminal- and platform-specific, and Windows/macOS have their own quirks.
- **A different CLI surface.** If opencode v2 ever moves the `/api/*` plane or
  changes how the TUI is pointed at a server, the gate catches it only through
  the real-TUI step — unit tests use a fake client by design.
- **Agents.** Compatibility here is about the *client*. Whether a given ACP agent
  behaves well is a different question, covered in
  [ACP-COMPAT.md](ACP-COMPAT.md).

## Windows

The unit suite runs on `windows-latest` (`.github/workflows/windows.yml`), which uses
**PowerShell** — GitHub's default shell there. The real-TUI acceptance cannot run: it
needs tmux and a POSIX login shell, so Windows TUI behaviour is unmeasured.

What is implemented and tested for Windows:

- an agent is killed with `taskkill /PID <pid> /T` (Windows has no signalable process
  groups); `windowsKillArgs` pins the arguments and the process-tree test runs there;
- the agent is spawned without `detached` (a detached Windows child would open a new
  console window).

**A `.cmd` shim is not a program on Windows.** npm installs the `opencode` CLI as
`opencode.cmd`, and `execFile`/`spawn` without a shell cannot launch one — they answer
`ENOENT` (or `EINVAL` through a pseudo-terminal) even though the command is right there on
`PATH`. Every place that starts a binary goes through `cmd.exe /d /s /c` there: the version
probe (`runVersion`), `printHelp()` and the ACP client's own agent launch (`launchSpec`).
The fixtures that cover this are real `.cmd` shims, so the Windows path is exercised by the
suite rather than skipped — measured: 432 passed / 0 skipped on Windows.

### `opencode acp` ignores `provider` before v2.0.32

A provider declared in `opencode.json` is visible to the TUI and to `opencode models` on
**every** v2 release, but `opencode acp` resolved its model list from the built-in providers
only on `v2.0.18`: `session/new` answered with 2 choices (`deepseek/*`) and no
the configured provider, and `session/set_config_option` refused the configured id with
`model not found`. Measured across five binaries on one machine, same config:

| binary | `configOptions.model` |
|---|---|
| v2.0.18 | 2 choices, **0** from the config's provider |
| v2.0.32 / v2.1.4 / v2.2.7 / v2.3.2 | 53 choices, **40** from the config's provider |

So an agent pointed at a custom provider needs `v2.0.32` or newer. Nothing here can fix it —
the model resolution happens inside `opencode`'s ACP subcommand, before the bridge is told
anything.

### The verified grid

`node scripts/e2e-matrix-real.mjs` runs every TUI build it can find × every agent it can find,
one three-turn conversation each, through the HTTP surface the TUI uses. It grades from the
transcript plus the agent's own error text, not from a captured screen — the screen shows
`Error: Internal error` for an agent whose real error is inside the ACP payload.

Result on 2026-11-22, against a single OpenAI-compatible endpoint, every cell a real conversation
that had to recall an earlier turn:

| platform | builds | result |
|---|---|---|
| macOS | 2.0.32, 2.1.4, 2.2.7, 2.3.2 | **20/20** |
| Linux | 2.0.32, 2.1.4, 2.2.7, 2.3.2 | **20/20** |
| Windows | 2.0.32, 2.1.4, 2.2.7, 2.3.2 | **20/20** |

Every row is 4 builds × 5 agents (`opencode acp`, claude-agent-acp, codex-acp, qwen,
`dsh --profile acp`).

`opencode acp` is a row per build because the agent command IS that build's binary — see
E2E-PITFALLS #14. Nothing is reported as blocked: an agent that is missing from a machine gets
installed rather than recorded as unable to run. The first Windows run said "dsh blocked (not
installed)", which was the harness describing its own gap as the agent's problem — see the note
on `dsh` below.

### Two things a second platform found

**`dsh` hardcodes its provider.** `dsh --profile acp` reads the LLM route from its profile, but the
`@deepseek-ai/dsh-acp` bundle names a provider of its own, so a profile that only declares a
provider leaves the agent answering `no API key for provider route "deepseek-official"` — the
route it was going to use, not the one that was configured. The override has to name the bundle:

```yaml
- id: acp
  name: "@deepseek-ai/dsh-acp"
  config:
    provider: my-llm         # the provider id declared under llm-pi-ai
    model: "deepseek-flash"
```

**`pnpm` builds an empty `opencode.exe`.** pnpm 12 skips `@opencode/cli`'s postinstall by default,
and that postinstall is what copies the real 200 MB binary into place — what remains is a 229-byte
stub. It still exists, so `existsSync` passes and the failure only shows up when it runs. Allow the
build before installing:

```yaml
# pnpm-workspace.yaml, next to package.json
allowBuilds:
  '@opencode/cli': true
```
