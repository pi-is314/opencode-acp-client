# Details

> [中文版](DETAILS.zh.md)

The parts of the README that a first-time reader does not need: what the tool writes to disk,
what a resumed session looks like, the rules the bridge is built around, and what it does not do
yet.

---

## Files it writes

All under `~/.opencode-acp-client/`. It **never writes into a native opencode v2 install**; the
session map stores ids, directories, titles and the agent's argv — **no message content and no
credentials**.

| Path | What it is |
|---|---|
| `sessions.json` | the session map (visible id ↔ the agent's own id, directory, title, agent) |
| `opencode/<agent-slug>/` | that agent's TUI state and data; config (`tui.json`, plugins, themes) is shared with your own install |
| `daemons/<pid>.json` | the registry `ps` uses; removed on a clean exit |

---

## What a resumed session looks like

It depends on which capability the agent announces — the tab title tells you which case you are in:

- It has `loadSession` → history is replayed; you see the original conversation.
- Only `sessionCapabilities.resume` (dsh's built-in `acp` profile is like this) → ACP's
  `session/resume` **does not replay history by spec**, so the tab is empty, but it keeps the
  real name and carries a `◈ Notice` explaining why. **Whether the context survived is not
  guaranteed by the spec.**
- Neither → the old session cannot be reattached; the tab becomes a **new conversation** titled
  `[new conversation] <directory name>`.

---

## Design rules

1. **Every inbound request gets an answer.** An agent that asks something and hears nothing back
   waits forever; anything we do not support is refused explicitly so the agent can degrade.
2. **Never assume a capability exists.** ACP is negotiated; the degradation rules are in
   [docs/ACP-COMPAT.md](docs/ACP-COMPAT.md).
3. **Prefer a noisy truth to a quiet guess.** A gap must be discoverable, not silently rendered
   as nothing.

---

## Known gaps

- Unimplemented routes: pty, MCP auth, provider OAuth, worktree changes, revert/share, most of
  `/tui/*` — they answer with a well-formed empty envelope, or a logged 404. The 355 requests a
  real session makes are all covered.
- **Other v2 clients are not recommended yet**: the state roots are injected into the TUI child
  we spawn ourselves, and no other client can be given them, so its tabs are not isolated per
  agent (see above).

