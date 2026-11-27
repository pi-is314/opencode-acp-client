# Development notes

> 中文版：[DEVELOPMENT.zh.md](DEVELOPMENT.zh.md)

Notes for anyone working *on* this bridge rather than just using it: the
server-only mode, how to watch what it does, and the traps that will cost real
debugging time if you meet them unprepared. For the product itself, read [README.md](../README.md).

##### Some routes keep failing on purpose

`POST /api/session/:id/{compact,fork,revert/stage}`, `POST /api/session/import` and
`POST /api/worktree` answer 204 where the client's generated client expects 200, which it
surfaces as `UnexpectedStatus` (a toast for `worktree.create`, silence for the rest). The
tempting fix — return 200 — is wrong here: the reason they fail is that **the feature does
not exist** in this bridge. A 200 would make the fork dialog close as though it had
forked. A route audit listed these as status mismatches; they are honest failures, and
changing them would turn a loud gap into a quiet lie (AGENTS.md rule 3).

## An unsupported route answers 200, not 404 — on purpose

`/api/*` routes we do not implement answer **200 with a well-formed empty envelope** and
log `[bridge] unhandled route:`. That is deliberate (`src/server.ts` says so): clients
read `.location` off these bodies unconditionally, so a bare 404 crashes them, and the
log is the real signal. So "this route should 404 instead" is **not** automatically the
safer change — it is a behaviour change to be measured against a real client. The one
known awkward case is `GET /api/fs/read/:path`, which the client reads as binary and
therefore renders our envelope as the file's contents; whether it tolerates a 404 has
not been verified.

## The agent runs in the session directory

The process is spawned with `cwd` set to the session's directory, not to yours. So an
agent command given as a **relative path** resolves there and dies immediately —
`AcpError: agent exited (code=1 signal=null)` with no `[acp]` line at all, because the
child never produced output. Use an absolute path (`node "$PWD/tests/fake-acp-agent.mjs"`)
or a command on `PATH` (e.g. `npx -y @agentclientprotocol/claude-agent-acp`). It cost this project a confusing
round: the probe looked like a broken client, and was a broken command.

## Server-only mode (`--bridge-port <n>`, or `--no-tui`)

`--bridge-port <n>` serves the HTTP/SSE surface on that port and starts no TUI (it
implies `--no-tui`); `--no-tui` alone serves on a random port. This is also how
another client attaches; the TUI is the only client verified
end to end here.

That surface is the published v2 OpenAPI surface: the TUI is the only client
verified end to end here. The test harness needs it without a TTY, and looking at
the raw surface by hand is also the fastest way to debug it:

```bash
node dist/index.js --bridge-port 4096 ~/project -- npx -y @agentclientprotocol/claude-agent-acp
```

It prints a ready line with the URL — always one JSON object on stdout:

```json
{"type":"ready","url":"http://127.0.0.1:4096","directory":"/home/me/project","agent":"npx"}
```

Start the TUI yourself if you want one:

```bash
opencode --server http://127.0.0.1:4096
```

In this mode a missing or v1 client is a **warning**, not a failure: the TUI may
be started separately, possibly from another machine, so the bridge serves
regardless. In the default mode, where the bridge launches the TUI and a human is
waiting for it, a usable v2 client is required.

## Watching a run

Every HTTP request is logged (`[http] METHOD /path`, plus bodies for writes) when
`OPENCODE_ACP_CLIENT_TRACE` is not `0`. That trace is what turned "the client did
nothing" into "the client sent nothing", and it is the fastest way to see the next
missing piece. Pair it with the client's own logs:

```bash
OPENCODE_ACP_CLIENT_TRACE=1 node dist/index.js --no-tui --bridge-port 4096 -C /tmp -- <agent command>
opencode --server http://127.0.0.1:4096 --print-logs      # watch the TUI
```

**To watch `[http]` logs you must use `--no-tui`**: in the default mode the TUI
owns the terminal, so our logs go to a file under `$TMPDIR` (a single stray output
line tears its rendering apart). stdout is always reserved for the ready line and
the ACP wire.

| Variable | What it does |
|---|---|
| `OPENCODE_BIN` | the opencode v2 client binary (else `opencode` on `PATH`) |
| `OPENCODE_ACP_CLIENT_TRACE` | every HTTP request and every ACP frame (very loud) |
| `OPENCODE_ACP_CLIENT_DUMP` | writes the raw `session/new` response to a path — the ground truth for an agent's capabilities |
| `OPENCODE_ACP_CLIENT_MESSAGE_PROBE` | the observer for the "messages disappear" bug |
| `OPENCODE_ACP_CLIENT_RECORD_FRAMES` | write every inbound ACP frame to `<dir>/<backend>.jsonl`, provenance line first — the raw material for a replay corpus |

Record one real turn into `tests/fixtures/acp_frames/` with `AGENT="dsh --profile acp" SCENARIO=turn node scripts/record-acp-frames.mjs`; refresh the snapshots with `UPDATE_FRAME_SNAPSHOTS=1 npx vitest run tests/frame-replay.test.ts`. The corpus format and its provenance rules are in `tests/fixtures/acp_frames/README.md`.
| `OPENCODE_ACP_CLIENT_PROMPT_TIMEOUT_MS` | optional prompt clock (default **disabled**; set a positive ms value; control requests stay at 120s) |
| `OPENCODE_ACP_CLIENT_RUN` | run the CLI even when the file is not the entry point (tests) |

Turn debug switches off when you are done.

## What the real client does now

Against opencode v2 driving a live model, a full turn round-trips. Two traps are
worth restating because they are **silent**, not loud:

- The composer returns `false` with **no toast** when `local.agent.current()` (or
  the selected model) is empty. Text stays in the box and nothing is sent — it
  looks exactly like a dead server. `/api/agent`, `/api/model` and
  `/api/provider` must be populated from the agent's ACP config options.
- `session.text.*` and `session.tool.*` **edit** rows and drop the event when the
  row is missing. Only `session.step.started` and `session.tool.input.started`
  create rows, so they must be emitted first.

Facts gathered along the way, all worth keeping:

- The TUI gates every action on a `session`; `packages/tui/src` is full of
  `!session` guards, and the composer only lives on `route.data.type === "session"`.
- `GET /api/session/active` is a **map** `{ "<sessionID>": "idle" | "running" }`,
  not `{sessionID}`. The client does `Object.keys(active)` to hydrate a status
  snapshot.
- `GET /api/session/active` returning anything but the map shape makes every id
  `undefined`, and the client then asks `GET /api/session/undefined` — which was
  the whole symptom before the map shape was fixed.
- `1 plugin failed` appears in the client footer in every directory, including a
  clean `/tmp`, so it is a bundled plugin rather than a workspace one. It is
  cosmetic and unrelated to any of the above.

## Committing

**Every commit in this repository is authored as `PI-is314`**:

```
PI-is314 <359395502+pi-is314@users.noreply.github.com>
```

`pnpm install` runs `prepare`, which points `core.hooksPath` at `.githooks/`; its `pre-commit`
refuses any other email. This exists because `git config user.email` lives in `.git/config`,
which is never cloned — a fresh clone on a machine whose global identity is another account would
commit under that account, and git history is public for good once pushed.

That address is GitHub's **noreply** form (`<account id>+<account name>@users.noreply.github.com`):
it makes GitHub attribute the commit to `pi-is314` without putting a real mailbox into public
history.

```bash
git config user.name  PI-is314
git config user.email 359395502+pi-is314@users.noreply.github.com   # once per clone
```

## Releasing

The version lives in **three places that must agree**: `version` in `package.json`, the git
**annotated tag** (`v<version>`), and the version published to npm. A release moves all three
together:

```bash
# 1. a clean tree and a green gate (see "Testing" above)
git status --short          # must be empty
pnpm typecheck && pnpm test

# 2. bump: npm commits for you (as PI-is314 — the hook refuses anything else) and tags
npm version patch           # or minor / major; produces a tag like v0.1.1

# 3. publish. ★ Name the registry and the token explicitly: this machine's default
#    registry is an internal one, and without --registry the package goes there
npm publish --registry https://registry.npmjs.org \
  --//registry.npmjs.org/:_authToken="$(tr -d '[:space:]' < ~/.npm.token)"

# 4. push the commit and the tag (--follow-tags pushes annotated tags only)
git push --follow-tags
```

**What npm requires, and what bites**:

- The token must be a **Granular Access Token with "Bypass 2FA" checked**; without it every publish
  answers `E403 … Two-factor authentication or granular access token with bypass 2fa enabled`.
  A plain token passes `whoami` and is still refused at publish — the two are not the same test.
- Right after publishing, `npm view <pkg> version` shows a `0.0.0-stage` placeholder. That is npm's
  staged publishing; it becomes the real version after about **two minutes**. Not a failure.
- Publish prereleases with `npm publish --tag next` so they do **not** take over `latest`; otherwise
  a plain `npm install -g <pkg>` hands people the test build.

**Verify the release** (all three should name the same version):

```bash
npm view opencode-acp-client version --registry https://registry.npmjs.org
git tag -l 'v*' --sort=-v:refname | head -1
node -p "require('./package.json').version"
```

## Running from a checkout

`package.json` declares `bin.opencode-acp-client`, but a bare `git clone` does not
put it on `PATH` — the package is never installed as a dependency of itself, so
`pnpm exec` cannot see it either. Pick one:

```bash
# 1. no install at all (always works)
node dist/index.js -- npx -y @agentclientprotocol/claude-agent-acp

# 2. a symlink, after pnpm build has set the exec bit
ln -sf "$PWD/dist/index.js" "$(pnpm bin -g)/oc-acp-client"
oc-acp-client -- npx -y @agentclientprotocol/claude-agent-acp

# 3. a wrapper, if you would rather not rely on the exec bit
printf '#!/bin/sh\nexec node %s/dist/index.js "$@"\n' "$PWD" > ~/.local/bin/oc-acp-client
chmod +x ~/.local/bin/oc-acp-client
```

Do **not** use `pnpm link --global .`: it adds the package as a dependency of
itself, rewrites `package.json`/`pnpm-lock.yaml`, and wants to purge
`node_modules`.

To undo (2): `rm "$(pnpm bin -g)/oc-acp-client"`.

## Process discipline

- End child processes by explicit PID / process group only. Never `pkill -f
  '<name>'`: it kills the user's editor or their other sessions. The existing
  `AcpClient.dispose()` shape (SIGTERM → 3s → SIGKILL) is right; keep it.
- Only one "start the TUI" process at a time: it picks a random port and spawns
  one TUI child process, so do not run two concurrently.
- Probe with a throwaway profile / temporary directory only, **never touch** a
  user's existing configuration, and never call a verb that really deletes data.

## Where the rest lives

- [ARCHITECTURE.md](ARCHITECTURE.md) — process model and one turn end to end
- [PROTOCOL.md](PROTOCOL.md) — the opencode v2 surface we implement, and its traps
- [../AGENTS.md](../AGENTS.md) — the entry point for developing this repo

## Testing

The commands that can prove a change to this bridge, from cheapest to most complete:

```bash
pnpm verify        # EVERYTHING this repo can prove: typecheck, unit, spec
                   # conformance, and the smoke / entry / real-TUI suites
pnpm verify:version 2.0.27   # the same gate against one specific opencode v2 release
pnpm test          # unit + the fake-agent integration tests
pnpm e2e           # 20 scenarios: fake agent, real HTTP (session → prompt → deltas, forms, cancel)
pnpm e2e:entry     # the single entry point: starts the TUI, propagates its exit code, leaves nothing
pnpm e2e:agent     # a real ACP agent, protocol level: needs AGENT="<command>" (this repo does
                   #   not preset one); no prompt unless PROMPT=1, so no tokens
pnpm e2e:tui       # the REAL opencode v2 TUI in tmux, against a fake agent, driving a rich
                   #   turn (reasoning + a tool call + a reply) and asserting what is ON
                   #   SCREEN: the user row, the reasoning block, the tool card with its
                   #   input, the reply, and the agent/model footer. Each captured screen
                   #   is saved under .artifacts/ — per-release evidence, not a claim
                   #   MODE=cancel FAKE_ENV='FAKE_ACP_HANG=1' pnpm e2e:tui  sends the cancel
                   #   gesture and reports what the bridge saw
```

### What a green run proves — and what it does not

`pnpm verify` is the gate, so before you read a green run as approval for your change,
know what it actually covers. Green means: the types check; 480 unit cases pass (the ACP
translation layer, the HTTP surface's shapes, the capability gate, the version policy,
cancellation semantics, and the SSE flows); every route we implement answers the shape
opencode v2's **published OpenAPI** describes (52 probes, with deliberate differences
recorded in `scripts/check-openapi.py`'s `ALLOWED` table rather than ignored); the
20-scenario smoke suite and the single-entry suite pass; and the **real** opencode v2 TUI,
driven in tmux, reopens a session and renders it.

Green does **not** mean — so do not treat it as evidence for: that a real agent's answers
are sensible (that is `pnpm e2e:agent` plus your own eyes); that the TUI looks right on
your terminal or on another platform; that any opencode v2 version other than the one
under test works (that is `pnpm verify:version`, and the release watcher running it per
release); or that features we deliberately do not implement suddenly work (see
[PROTOCOL.md](PROTOCOL.md)). Unit tests cannot see a rendered screen — that is why the e2e
scripts and the version gate exist.

---

## The one file the bridge writes

`~/.opencode-acp-client/sessions.json` (relocate with `OPENCODE_ACP_CLIENT_SESSION_MAP`),
plus a per-process `daemons/<pid>.json` record (written at startup and removed on a clean
shutdown; `oc-acp-client ps` reads it to list live/stale bridges, `--prune` forgets the stale
ones, `--kill` explicitly stops live ones; relocate with `OPENCODE_ACP_CLIENT_DAEMONS`).

The map holds: the session id, the agent id behind it, the directory the session runs in, and an
optional agent title — no message content, no credentials, at most 500 entries, and a read/write
failure is only logged, never fatal: it is an optimisation, not storage.

It exists because **ACP does not let a client name a new session**. `session/new` has no id field
(only `{_meta, additionalDirectories, cwd, mcpServers}`) and the agent generates and returns the
id; measured against dsh, even `_meta.sessionId` is not honoured. The opencode v2 client, though,
remembers **the id it was shown**, so without this table a restored tab loads an id the agent has
never heard of → the load fails → the tab opens **blank**. A generic ACP client cannot do this at
all; it can only accept the agent's own id.

**One direction only.** The map holds visible id → agent id. It used to also write the agent id
mapped to itself, and nothing ever read that entry: the client only ever asks for the `ses_…`
alias the bridge showed it (measured — the TUI requests `ses_ec3718af…` and `ses_acp_…`, never a
bare UUID), and the sole reverse lookup requires the key to start with `ses_`. The entries were
not free: they were 79 of 153 rows (52%) in the owner's file, and because the file is truncated
at `MAX_ENTRIES` after sorting by age, dead entries could evict live mappings. A regression test
now asserts no key equals its own `acpSessionId`.

## Agent probes and resume observations

Agent-specific measurements are development evidence, not product compatibility. Use
`pnpm e2e:agent` for a protocol-level probe without a model prompt; it reports the negotiated
capabilities and a model catalog after a session reaches ACP. Do not turn a missing measurement
into a claim that an agent needs credentials or lacks a feature.

For resume, inspect the `initialize` capability log (`[acp] initialized: {…}`): only an agent
that advertises `loadSession` may receive `session/load`. Even that capability does not promise
that the agent will replay a transcript. The bridge logs an unavailable or failed resume and
falls back visibly rather than silently claiming restoration. When adding an agent-specific
probe or a weaker capability case, extend `tests/fake-acp-agent.mjs` instead of mocking an ACP
client inside a test.

## Running the gate on Linux (Docker)

macOS is the author's machine; Linux is the container. The image has Node, pnpm, tmux,
zsh, python3 and `jsonschema`, and runs `pnpm build` itself:

```bash
docker build -f docker/linux-gate.Dockerfile -t oac-linux-gate .
docker run --rm oac-linux-gate                      # the whole gate
docker run --rm oac-linux-gate bash -c 'pnpm test'  # one step
```

The base defaults to `node:22-alpine`; on a host that cannot reach Docker Hub, pass the
base and an apk mirror it can reach:

```bash
docker build \
  --build-arg BASE_IMAGE=<internal-alpine-base> \
  --build-arg APK_MIRROR=https://mirrors.tuna.tsinghua.edu.cn \
  --build-arg INSTALL_NODE=1 \
  -f docker/linux-gate.Dockerfile -t oac-linux-gate .
```

The Linux run is not a formality: it found four macOS assumptions in the tests — `dsh`
assumed on PATH, a link checker that needs `git`, two reply assertions racing the
asynchronous POST, and a `/cd` assertion hardcoded to `/var/folders/…`. Keep the image
building; it is the only place those are caught.
