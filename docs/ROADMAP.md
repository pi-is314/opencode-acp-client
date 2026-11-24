# Roadmap — three things we know we owe, and deliberately do **not** do in this version

> 中文版：[ROADMAP.zh.md](ROADMAP.zh.md)

> The point of this page: write down what we know we owe, and **why it is not being done now**.
> Each item carries "where it stands today" and "what must be re-confirmed before starting", so
> the next person does not have to redo the research from scratch.
>
> Status: all three **not started**.

---

## 1. Verify and complete support for opencode desktop

**Where it stands:** the documentation **does not recommend any non-TUI client**, and the
`--bridge-port` section no longer mentions desktop either.

The reason is **specific and verified**, not "we never tried":

| Fact | Where it comes from |
|---|---|
| The bridge isolates the TUI's state roots per agent | `XDG_STATE_HOME` / `XDG_DATA_HOME` / `OPENCODE_DB` are set on the child we spawn (`tuiEnv` in `src/index.ts`) |
| **No other client can be given them** | A client's storage roots are decided **when it starts**; an HTTP server cannot change them |
| Consequence | A second client against the same bridge has tabs that are **not separated per agent** — exactly the mixing the isolation exists to prevent |

★ That isolation came out of **fixing a bug** (two agents' tabs mixed together, the model picker
answered for the wrong one), so it is not an optional optimisation — it is the correct behaviour.

**Questions to answer before starting:**

1. Does desktop recognise a state directory that is **communicated over HTTP**? (If it reads one
   from Settings, the user could perhaps be guided to change it.)
2. Desktop consumes a wider surface than the TUI (`/api/fs/list`, provider, integration and other
   routes) — **which of them must be implemented**?
3. Its "Add server" card gets stuck on the **health probe** (that is why both `/api/health` and
   `/api/info` are served) — has the probe endpoint moved again since v2?
4. Once isolation is possible, **`--bridge-port` and the "not yet" paragraph in the README have to
   be changed back together** (`git log --grep "stop recommending other v2 clients"` finds that
   commit).

**How it would be accepted**: to the same standard as the TUI — **asserted against the screen**,
not "the endpoint answered" (AGENTS.md rule 8). If desktop's behaviour can only be judged by hand,
the documentation must say "not automated" outright rather than hint that it works.

---

## 2. Implement ACP v2

**Where it stands:** only **ACP v1 (stable, schema v1.25.0)** is implemented.
`docs/ACP-MATRIX.md` records, method by method, which v1 methods we advertise and implement.

**v2 has been published:**

- Docs: <https://agentclientprotocol.com/protocol/v2/overview.md> (append `.md` for plain text)
- **There is a dedicated migration guide**: <https://agentclientprotocol.com/protocol/v2/migration.md>
- Its schema release is named differently from v1: the URL `schema-v2.0.0` **is a 404**, so before
  starting, find where the v2 schema actually lives via `meta.json` or `llms.txt`.

★ **Known changes** (read from the v2 overview; the migration page is the authority when work
begins):

- `initialize` is followed by an **authentication flow** (`auth/login`), either an Agent method or
  the terminal route of "start it and reconnect";
- session setup is `session/new` **or `session/resume`** (in v1 `resume` is capability-gated; v2
  puts it on the main path);
- **Session Delete**, **Slash Commands** and **Errors** are new or have their own pages.

**Questions to answer before starting:**

1. **We advertise v1 — does v2 require supporting both?** Does the spec define version
   negotiation?
2. Does v2 **remove** anything we depend on? (What do v1's 14 `session/update` variants become in
   v2?)
3. **opencode v2's surface (`/api/*`) does not change** — it is only the UI adapter layer and is
   independent of the ACP version. So the boundary is clear: **only `src/acp/**` and the
   translation layer move**, but the translation layer is "the single most central file".
4. `docs/ACP-MATRIX.md` for v1 was built by **measuring every row**; v2 needs the same measurement
   redone, not its conclusions copied.

**Risk**: the translation layer is a single point — changing it touches every rendering path.
Per AGENTS.md rule 6, **check the spec first, then write code**; per rule 8, **every change is
accepted on the real TUI, against the screen**.

---

## 3. Implement a resident bridge process

**Where it stands:** **the bridge is born with the TUI and dies with it.** In the default mode one
process runs both the bridge and the TUI; `--no-tui` runs the bridge on its own, but **in the
foreground**, so making it resident is left to the user's own `&`.

**How opencode does it** (already read; source is `packages/client/src/service-contender.ts`):

| Mechanism | What opencode does |
|---|---|
| A detached process | `spawn(..., { detached: true })` + `child.unref()`, fully cut loose from the parent |
| Finding it again | A **registration file** (in the XDG state directory): `{ id, version, url, pid, password }` |
| **What about upgrades** | `Service.ensure()` compares the `version` in the registration file with its own, and **kills and restarts when they differ** |
| Stopping cleanly | `StopOptions.pty: "clear" \| "handoff"` — persistent terminals can be handed over instead of killed |

**Why it is not being done now** (not "we did not think of it" — the costs are concrete):

1. **The upgrade semantics get harder**: opencode only compares its own version; we would compare
   **two** — the bridge's **and** the agent command it spawned. What happens when the agent changes?
2. **One resident bridge drives one agent** (an architectural consequence: one ACP connection per
   agent program). Switching agents means switching bridges ⇒ the registration file cannot be a
   single file, or it has to be per agent.
3. **Configuration and directory are fixed**: the bridge is bound to one directory and one agent,
   and every client connecting to it has to accept that.
4. **Safety**: an agent can run arbitrary commands, so "resident" means "always running" and the
   exit policy has to be explicit (idle timeout? manual stop?).
5. **A service you cannot stop is a disaster**: it needs a whole set of subcommands —
   `service start/stop/restart/status`.

**One related fact worth knowing**: **the agent child exits when the bridge exits**, so any agent
capability that would have to keep running after the TUI closes (scheduled tasks, background
subagents, long jobs) does not continue. That is not a bug; it is the boundary of the current
architecture.

**Questions to answer before starting:**

1. What goes in the registration file? At minimum the **bridge version** and a **fingerprint of the
   agent command**.
2. The `ensure` rule: when the version/agent differs, **kill and restart** or **let them coexist**?
3. How does a TUI connect to an existing bridge? It needs an entry point like `--attach <url>`
   (there is **none** today).
4. How long idle before it exits? Who reaps a registration file left behind by a crash?

---

## Outside the list

These three are **independent of each other** and can be taken on separately as needed. If more
items appear later, add them here rather than scattering them across documents —
`KNOWN-ISSUES.zh.md` records **things that happened and are not fixed yet**; this page records
**features not started**.

## 4. Trim the README, and put a logo and a screenshot on it

**What**: the README has grown by accretion — every verified fact, every trap and every version
row lives on it. It should read like an introduction instead: what this is, one screenshot, one
command line, three links (protocol, compatibility, design rules). The reference material already
has a home in `docs/`.

**Reference**: [openma-ai/Martty](https://github.com/openma-ai/Martty) and
[Kagura-0001/lucid](https://github.com/Kagura-0001/lucid) — both lead with a logo, a screenshot
and a short pitch, and leave the depth to pages below.

**Constraints**:

1. **Bilingual**: every change lands in `README.md` and `README.zh.md` together; `check-links.py`
   is what enforces the pair.
2. **Nothing may be lost, only moved.** Every fact removed from the README must already exist in
   `docs/` — and it must still be reachable from the entry document (`AGENTS.md` §1 is the
   reading order).
3. **The screenshot has to be honest**: a real TUI with a real agent, captured the way
   `scripts/e2e-real-tui.sh` captures panes, not a mock-up.
4. **A new branch.** This is a rewrite of the front page and would otherwise bury unrelated work
   in review.

