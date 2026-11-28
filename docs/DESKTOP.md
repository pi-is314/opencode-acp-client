# Driving opencode desktop from this bridge

> [中文版](DESKTOP.zh.md)

opencode desktop speaks the same HTTP/SSE surface as the TUI, so it can talk to this bridge
instead of to opencode's own server. **Everything about using the desktop — adding a server,
adding a project, opening a conversation, the terminal tab, `/agent`, the model picker — is the
desktop's own and is not described here.** This page covers only what belongs to the bridge: how to
start one for a desktop, what it can and cannot do in that role, and how to stop it.

---

## Start a bridge

```bash
oc-acp-client --bridge-port 8765 ~/project -- <agent command>
```

`--bridge-port` implies `--no-tui`, so no terminal UI is drawn; the bridge prints one ready line
carrying the URL it is serving, and that is the address to point the desktop at.

| Flag | Why a desktop run needs it |
|---|---|
| `--bridge-port <n>` | picks the port; without it the bridge takes a free one and the address changes each run |
| `--bridge-host <addr>` | only when the desktop runs on **another machine** — see the warning below |
| `--bridge-log <file>` | writes the request log somewhere you can read; there is no terminal to watch |

★ **One bridge drives one agent.** Sessions multiplex over a single ACP connection, and the bridge
lays out its state per agent. Two agents need two bridges on two ports, which is also how the
desktop shows two servers.

★ **`--bridge-host 0.0.0.0` has no authentication.** Anything that can reach the port can drive the
agent: read its transcript, run its tools. Keep the default (`127.0.0.1`) unless the network in
between is trusted, and prefer an SSH tunnel when the desktop is on another machine.

---

## What the bridge answers for a desktop

The TUI exercises a narrow part of the surface; the desktop decodes more of it, and the difference
is where the defects were. All of these are implemented, and each has a story — see the commit
history around `318a5e7`:

| Route | What the desktop does with it |
|---|---|
| `/api/project` | builds the project tree; every entry needs `worktree`, `sandboxes` and `time` |
| `/api/config` | reads the config document; an empty array is valid JSON and still broke session creation |
| `/api/session` | lists conversations; a session needs a `model` for the desk to decode it |
| `/api/model` | fills the model picker |
| `/api/agent` | lists the ACP modes as agents |
| `/api/health` and `/api/info` | the "Add server" card probes both |

★ **A client that renders less is not a client that is easier to satisfy.** The TUI ignored
`sandboxes`; the desktop read it unguarded and threw. When a route is added or a field changes,
check it against a real `opencode serve` before assuming the bridge's answer is complete.

---

## Stopping it

A bridge started with `--bridge-port` serves whoever connects, so **nothing tells it when the
desktop closes** — it keeps running, with its agent, until you stop it.

```bash
oc-acp-client ps            # the bridges running right now: pid, state, age, agent, directory, URL
oc-acp-client stop          # the only live one; refuses and lists them when several are running
oc-acp-client stop <pid>    # that one
oc-acp-client stop --all    # every live one
oc-acp-client ps --prune    # forget records whose process is already gone
```

★ **`stop` sends SIGTERM and waits for the exit.** The bridge's own shutdown closes the server,
forgets its record and **kills the agent it spawned**. A SIGKILL skips all three, and the agent
survives as an orphan holding the workspace lock — which is what makes a later `session/load` fail
with "Internal error" while the new bridge's own log looks healthy.

★ `ps` shows `stale` for a record whose process is gone (a crash, a `kill -9`, a reboot). Those are
harmless but they accumulate — one per crashed run — and `ps --prune` clears them.

---

## What a desktop conversation looks like in the bridge

Nothing special: the desktop is one more client of the HTTP surface, so a turn behaves as it does
in the TUI. Two things are worth knowing when reading the bridge's log:

- **The desktop sends its own `session.agent` before every prompt** once it has a selection, so
  `[bridge] mode -> …` lines appear where the TUI would show nothing.
- **It subscribes to `/api/event` and reconnects after a pause**; several `GET /api/event` lines in
  a row are a reconnect, not a leak.

---

## The harness

`scripts/e2e-desktop.mjs` drives a **source** build over CDP and is not part of `pnpm verify` — it
needs the opencode repository next to this one, and it starts an Electron app. It covers the paths
this page does not describe (adding a server, opening a conversation, a tool card, the agent
picker, the plan surface) because those are the desktop's own; the reason it exists is to prove the
bridge answers them.

```bash
node scripts/e2e-desktop.mjs            # the conversation path
MODE=permission node scripts/e2e-desktop.mjs   # the approval dialog, which blocks a turn
```

★ It runs against the **dev** desktop only (`ai.opencode.desktop.dev`); the installed app is never
touched.
