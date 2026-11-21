# Architecture

> 中文版：[ARCHITECTURE.zh.md](ARCHITECTURE.zh.md)

## Process model

One bridge process. Inside it:

```
                 ┌───────────────────────────────── oc-acp-client ──────────────────────────────────┐
opencode v2 client │                                                                         │
   │ HTTP/SSE    │  src/server.ts      routes + lifecycle                                    │
   ├────────────▶│    │                                                                      │
   │             │    ├── src/sse.ts        SseHub: fan-out + bounded replay ring            │
   │             │    ├── src/state.ts      sessions / messages / parts (in-memory)          │
   │             │    └── src/translate/    ACP session/update → opencode v2 events          │
   │             │          ▲                                                                 │
   │             │          │                                                                 │
   │             │  src/acp/client.ts   JSON-RPC over stdio, request correlation, timeouts    │
   │             │          │                                                                 │
   │             └──────────┼─────────────────────────────────────────────────────────────────┘
   │                        │ ACP stdio
   │                        ▼
   │                    one ACP connection per agent program (sessions multiplexed)
```

**One ACP connection per agent program, sessions multiplexed.** One process per
`(command, args)`; every session is a `session/new` on it. Each session still has its
own catalog (`AcpClient` tracks config per session id) and its own translator, and
**only the process is shared**. The cost is real: an agent crash or exit takes every
session on that connection with it.

**Tabs are hydrated lazily, on purpose.** The native opencode v2 TUI prefetches every
remembered tab (metadata immediately, then each transcript 300 ms later) — cheap
there, because one server process reads SQLite. Here a transcript read that has to
be loaded is a whole agent process doing `session/load`/`session/resume`, and a
backend with a workspace lock (dsh) refuses the second load. So the bridge loads
the transcript the visible tab asks for, answers any *concurrent* background
tab's read from what it has (`[bridge] lazy: … answered without loading`), and
loads that tab when the user actually opens it — switching tabs mounts the
session, which re-reads its transcript.

## A turn, end to end

```
client                     bridge                          agent
  │ POST /api/session/:id/prompt
  ├─────────────────────────▶
  │                          │ append user message, emit message.* for it
  │ ◀── 200 placeholder ─────┤ (response returns immediately; the turn runs on)
  │                          │
  │                          │ spawn agent (lazily) → initialize → session/new
  │                          ├───────────────────────────────▶
  │                          │ ◀──────────── sessionId ────────
  │                          │ emit turn.wait + session.status(busy)
  │                          ├── session/prompt ─────────────▶
  │                          │                                │
  │ ◀── message.part.delta ──┤ ◀── session/update(chunk) ──────┤
  │ ◀── message.part.updated─┤
  │ ◀── permission.asked ────┤ ◀── request_permission ─────────┤
  │ POST …/permission/:id/reply
  ├─────────────────────────▶ ├── result(selected) ──────────▶
  │ ◀── permission.replied ──┤
  │                          │ ◀── prompt resolves(stopReason)─┤
  │ ◀── session.idle ────────┤ emit turn.idle + session.status(idle)
  │ ◀── turn.idle ───────────┤
```

Two things that are easy to get wrong and are deliberate here:

- **The HTTP response is a placeholder.** Awaiting the whole turn would block the
  request for minutes and the client would time out. The real content arrives on
  `/api/event`.
- **Every open part is closed at turn end.** A `reasoning` part that never gets
  an `end` is a spinner that never stops — most visible when a turn is
  interrupted and no final message ever arrives.

## Modules

| File | Responsibility |
|---|---|
| `src/index.ts` | CLI parsing; prints the ready line |
| `src/server.ts` | routes, session verbs, the prompt/turn lifecycle |
| `src/sse.ts` | `/api/event`: fan-out, `server.connected` handshake, bounded replay for `Last-Event-ID` |
| `src/state.ts` | sessions, messages, parts |
| `src/contract.ts` | the opencode v2 surface we implement (observed, not invented) |
| `src/acp/client.ts` | spawn, JSON-RPC, correlation, timeouts, callback answering |
| `src/acp/capabilities.ts` | negotiate + degrade |
| `src/translate/events.ts` | the ACP→opencode v2 mapping |

## Failure policy

| Situation | Behaviour |
|---|---|
| Agent never answers a request | per-request timeout (default 120s) → rejects, turn ends with an error |
| Agent calls `fs/*` or `terminal/*` | explicit `-32601` error; we never advertised those, and silence would hang it |
| Agent dies mid-turn | pending requests reject; `turn.idle` still fires so the UI unsticks |
| Unknown HTTP route | `404` + a `[bridge] unhandled route:` log line |
| Unknown `session/update` | ignored + logged |
| Unsupported prompt blocks (image/audio/…) | dropped before sending + logged |

## Why one agent process serves several sessions, and why lazy

Spawning on first prompt keeps startup instant and means a client that only lists
sessions never pays for an agent. Per-session processes make `abort` and a crash
local to one conversation.
