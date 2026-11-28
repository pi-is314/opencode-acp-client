# Roadmap — what we know we owe, and where each item stands

> 中文版：[ROADMAP.zh.md](ROADMAP.zh.md)

> The point of this page: write down what we know we owe, and **why it is not being done now**.
> Each item carries "where it stands today" and "what must be re-confirmed before starting", so
> the next person does not have to redo the research from scratch.
>
> Status: **1 done** (opencode desktop, since 2026-11-28); 2 and 3 **not started**.

---

## 1. opencode desktop — supported, with one limit that belongs to the desktop

**Where it stands:** desktop holds a conversation against the bridge, and `scripts/e2e-desktop.mjs`
proves it (15 checks, including a tool card, the agent picker, the plan surface, the terminal
surface and the approval dialog). How to run one is in [DESKTOP.md](DESKTOP.md).

The questions this section used to raise are answered:

| Question | Answer |
|---|---|
| Does desktop find a state directory over HTTP? | Not needed. Isolation is per **bridge**, not per client: one bridge drives one agent, and its state layout is already per agent |
| Which routes must be implemented? | The ones it actually decodes — `/api/project`, `/api/config`, `/api/session`, `/api/model`, `/api/agent`, `/api/health`, `/api/info`. **Four of them were answering less than the schema requires** and each one crashed the desk in a different place; see `318a5e7` |
| Does the "Add server" card still get stuck on the health probe? | No; both endpoints answer |

★ **The one thing that cannot be fixed here.** A client that keeps its own list of projects (the
desktop does) only shows a project it has been told about, and told about through its own picker.
The bridge cannot add one on its behalf — that is the desktop's model, and the same is true of any
server it points at, not something this bridge introduces. It is a step in the desktop's normal use,
not a limitation to document around.

★ **A note for the next client.** The TUI ignores fields the desktop reads without a guard. A route
that satisfies the TUI can still crash the desk, so "the user interface renders it" is not the bar
for a new route — compare against a real `opencode serve` (DESKTOP.md, "What the bridge answers").

### 1a. What was measured on 2026-11-24 (macOS, OpenCode.app 2.0.32 → 2.4.1)

★ **desktop WORKS against this bridge.** Driven end to end through CDP: add server → open a session
→ send a prompt → the reply renders. So question 3 above ("stuck on the health probe") is **no
longer true** — `/api/health` + `/api/info` are enough.

★ **How to drive it** (this is the automation base):

```
/Applications/OpenCode.app/Contents/MacOS/OpenCode --remote-debugging-port=9223
```

`--remote-debugging-port` must go on the **command line**. `environment.ts` only reads
`OPENCODE_DESKTOP_REMOTE_DEBUGGING_PORT` when `!app.isPackaged`, and the shipped app IS packaged.
One CDP target: `oc://renderer/index.html`. Adding a server: 设置 → 服务器 → the page's top-right
添加服务器 → menu 添加服务器 → URL → 添加服务器 (**password may be left empty**). The menu items
only open on `pointerdown`+`pointerup`+`click`; a bare `.click()` does nothing.

★ **The local server is desktop's OWN opencode**, not the bridge: it runs
`opencode-cli serve --service` from `~/Library/Application Support/ai.opencode.desktop/cli/`, and
its sessions are native opencode data. A failure there is **fatal** (the window shows an error page
and the app quits); there is no "external server only" mode.

★ **Why isolation is still blocked, precisely.** Three of the four switches are gated on
`!app.isPackaged`:

| Switch | Effect on a packaged desktop |
|---|---|
| `OPENCODE_DESKTOP_TEST_ROOT` | ✗ `createTestRoot` returns undefined when packaged |
| `OPENCODE_DESKTOP_ISOLATED_SERVER=1` | ✗ it is what adds `serve --port 0`; measured `args=["serve","--service"]` |
| `--user-data-dir` | ✗ `app.setPath("userData", …)` overwrites it |
| `OPENCODE_TEST_ONBOARDING=1` | ⚠ only this one survives, and it **moves XDG roots** (+`OPENCODE_DB=:memory:`) while leaving the PORT alone |

**The port is the wall.** `defaultPort()` (`packages/cli/src/services/service-config.ts`) is
`0xc0de` = **49374** for channel `latest` (what a release desktop runs), `0xc0df` for `local`, and a
hash-derived 10000..60000 otherwise. Two desktops therefore cannot run at once, and an isolation
attempt collides with the user's own instance:

    Managed service port 49374 on 127.0.0.1 is already in use by another process.

`opencode service set port <n>` is the documented escape — **but it edits the USER's global service
registry**, so a test must never call it (it was called once during this investigation and had to be
reverted).

⟹ **A packaged desktop cannot be tested in isolation. Testing it means running desktop from source**
(`packages/desktop`, `bun run dev`), which sets `OPENCODE_CHANNEL=local` (port 49375) **and**
`OPENCODE_DESKTOP_ISOLATED_SERVER=1` (random `--port 0`) with `isPackaged === false` — every switch
above then works. Until that harness exists, the per-agent tab isolation question (the one this
section has always been about) stays open.

★ **Two real bridge defects were found by this work and fixed** (commit `e6781f6`):

1. `GET /api/project` answered a hard-coded `[]`. The TUI never asks for it, so nothing caught the
   defect; a client that builds its project list from that route sees no project at all. The route
   now lists the sessions' directories (plus the launch one), deduplicated.
2. `location.project.id` hashed the raw launch string while `projectIdFor()` — used by every other
   surface — hashes `realpath()`. On macOS `/var/...` is `/private/var/...`, so the same workspace
   produced `proj_d94b…` from one route and `proj_f4e4…` from the other; a client that looks the
   location's id up in `/api/project` finds nothing.

★ **What still does not work, measured 2026-11-26**: a dev desktop launched moments ago asks for
`/api/project`, `/api/location` and `/api/vcs`, draws the added server in its sidebar, and then
**never sends `GET /api/session`** — so no conversation is listed. One occurrence did list the
session, on a desktop that had already been running; the same click on a fresh one did not, and
settling 15 s+ did not change it. Dead server entries were ruled out. `scripts/e2e-desktop.mjs`
(`pnpm e2e:desktop`) is the harness for this: its first eight checks pass, the last two fail, and
it is deliberately **not** in `pnpm verify`.

★ **Cleanup trap, learned twice**: `pkill -f "OpenCode.app/Contents/MacOS/OpenCode"` kills the app
but **not the `opencode-cli serve --service` child it spawned**. That orphan holds 49374 and every
later desktop launch dies with the port error. After any desktop experiment:
`ps aux | grep "[o]pencode-onboarding"` must be empty.

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

**Also the logo**: a mark in the same spirit as opencode's — one that reads at 40px and works on
light and dark. `logo.png` / `logo.svg` at the repository root are that mark, and the README leads
with it.

★ **Shipped in v0.2.0** (2026-11-26): `logo.png` / `logo.svg` at the repository root, the four
letters the exit wordmark was missing, and [CHANGELOG.md](../CHANGELOG.md) as the release record.
The README trim and the screenshot below are **still open** — this section is about those two now.

★ **What a file at the root does NOT do** (measured 2026-11-24, when the repository icon did not
change after `logo.png` was pushed): **GitHub does not take a repository avatar from it.** A
repository has no avatar of its own — its icon in a list is the owner's avatar, an organisation's
icon is set on the organisation, and a personal account's is the account's. There is no field in a
repository's Settings for it. Earlier revisions of this page said "the file the repository page
uses is the file the README shows", which was wrong.

What the root files do serve: the README (via `<img>`), and the **social preview / Open Graph
card**, which is uploaded separately under Settings → Social preview and is a **1280x640** image —
a different asset from the 1:1 `logo.png` here, and not generated yet.

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

