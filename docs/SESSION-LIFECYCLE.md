# Session Lifecycle — the two faces of an id, the resume paths, and the timing traps

> ★ The part of this repository most prone to bugs: every mechanism here answers one real failure.
> 中文版：[SESSION-LIFECYCLE.zh.md](SESSION-LIFECYCLE.zh.md)

## Contents

0. Why sessions go wrong so easily
1. The two faces of an id and the map (including 1.2: which agent a session belongs to)
2. The resume paths (pre-created record, reusing the shell, `-c`, adoption)
3. `ensureAgent`'s id precedence
4. "Newest session", the epilogue line, the three resume outcomes, where the title comes from
5. The timing traps (each one a measured failure)
6. A resume sequence diagram
7. Multiple tabs: prefetch, lazy loading, and each tab's own agent and model catalog

## 0. Why sessions go wrong so easily

Three structural reasons, and once you understand them every mechanism further down is a
necessary consequence:

1. **A session has two ids.** ACP defines `session/new` with **no** id parameter — the agent
   mints the id itself (usually a UUID); while opencode v2's spec requires a session id to
   match `^ses_…`. So **nobody is allowed to pretend they are the same**.
2. **The truth lives in three processes.** The session's body sits with the agent (we **persist
   no messages at all**); "which pair of ids is the same session" lives only in the bridge's map;
   "which tab was open last time" lives only in the TUI's memory. Any one of them coming unhooked
   and the resume is empty.
3. **The agent is a single writer** (measured on dsh: for the same session/workspace, a second
   process's `session/load` answers "Internal error"). Two paths touching one session at the same
   time = guaranteed failure, so **timing** is not a detail, it *is* correctness.

```
         ┌──────────────────┐   visible id (ses_…)       ┌───────────────────────┐
         │  opencode v2 TUI │◀──────────────────────────▶│                       │
         │  remembers which │   HTTP + SSE               │       the bridge      │
         │  tabs it opened  │                            │                       │
         └──────────────────┘                          ┌─│  the map (the only    │
         ┌──────────────────┐   agent id (UUID)          │ │  persisted state)     │
         │     ACP agent    │◀───────────────────────────┼─┤                       │
         │  session body /  │   ACP stdio (JSON-RPC)     │ └───────────────────────┘
         │  title (the      │                            │
         │  agent's store)  │                            ▼
         └──────────────────┘               ~/.opencode-acp-client/sessions.json
```

## 1. The two faces of an id and the map

| | visible id | agent id |
|---|---|---|
| **who mints it** | the bridge (`ses_…`, per the opencode spec) | the agent (dsh: a UUID) |
| **who uses it** | the TUI's tabs, HTTP routes, the argument to `--session`/`-s` | ACP's `session/load`/`session/list`/`session/prompt` |
| **where it lives** | the TUI's own memory + the bridge's map (as the key) | the bridge's map (as the value) + the agent's own store |

The map is **the only persisted file in this repository** (`~/.opencode-acp-client/sessions.json`;
besides it there is a per-process
`daemons/<pid>.json` registry, deleted on a clean exit, used by `oc-acp-client ps`,
and `OPENCODE_ACP_CLIENT_SESSION_MAP` renames/relocates it):

```json
"ses_a1b2c3d4e5f6…" : {
  "acpSessionId" : "9f8e7d6c-5b4a-…",      // the real id on the agent side
  "directory"    : "/…/my-project",         // which workspace the session belongs to (updated after /cd)
  "title"        : "Explain this codebase", // the title the agent gave it (optional)
  "agent"        : { "command": "dsh", "args": ["--profile", "acp"] }, // who created it (optional; see below)
  "updatedAt"    : 1792135708656
}
```

When it is written: **only once the session has really been used** — a prompt went through a full
turn, adoption hit, or discovery imported a titled session.
**A shell that was never prompted never enters the map**.

★ `agent` = the **argv** of the agent that created it (`{command, args}`, never through a shell).
ACP has no notion of "which agent this session belongs to"; `session/resume` only knows the id, so
reopening with another agent pushes the old tab's id into the current agent — measured: create a
session with `opencode acp`, then reopen with `oc-acp-client -- dsh -- profile acp`, and that tab
can only be empty or throw, while the screen says nothing about why.
**Current policy: one client drives only the agent named on its launch command line**; entries that
belong to another agent are refused (404) on adoption/`-s`, and its own agent is no longer spawned
(see §1.2).

### 1.1 The reverse-lookup rule (the `visibleIdFor` fix)

On a discovery import we have to find the existing visible id for an agent session:

```text
given a directory: first match the agent id exactly among "entries for that directory";
none → fall back to "old-format entries with no directory at all";
still none → mint a new alias ses_acp_<uuid-with-dashes-removed>.
```

★ Why the fix: the same agent session had been used in two workspaces, and the import in workspace
A once grabbed the alias written by workspace B — that alias maps to B's directory, so restoring
under A loads nothing.
**Never cross directories**, the directory is part of a session's identity.

### 1.2 Which agent a session belongs to (the `agent` field)

ACP has **no** notion of "which agent this session belongs to": `session/resume`/`session/load` only
know the id; where it is stored and whether it can be used concurrently are wholly up to the agent's
implementation. So on "reopen with another agent" the bridge used to hand opencode's session id to
dsh — measured as an empty tab, with **no reason at all** on screen.

The map now stores one more field:

```json
"agent" : { "command": "opencode", "args": ["acp"] }
```

- **argv, not a shell string**: spawned by a direct exec, never through a shell;
- **same as** the agent launched this time → adopt/resume normally (`record.agent` stays unset; the
  launched agent is used);
- ★ **different from** the agent launched this time → **refused (404)**: no other agent is spawned and
  its id is never handed over:
  ```text
  [bridge] refusing 'ses_…': it belongs to 'opencode acp', this bridge drives 'dsh --profile acp' — launch the client with that agent instead
  ```
- `-s <another agent's id>` fails right at the CLI entry (`session … belongs to '…'`) and never gets
  as far as launching;
- ★ **old entries without that field are refused (404) too**: the identity is unknown, and that is not
  something to guess at.
- The TUI's state root is isolated per agent (`~/.opencode-acp-client/opencode/<slug>/`), so an old tab
  usually does not even appear; this layer is the hard boundary for `-s`, hand-written maps and
  leftover tabs.

(The old policy was "bind each session to its own agent and spawn it when needed". It made opencode
tabs show up in a dsh launch, and dragged opencode's model catalog into the new tab's composer.)

## 2. The resume paths (three, strictly distinguished)

```
--session <id> (explicit)        -c / --continue (implicit)    tab click/reopen (passive)
──────────────────────          ────────────────────────      ──────────────────────
at startup:                      at startup:                     TUI asks GET /api/session/<id>:
 1. parseArgs gets the raw id     1. one-shot ACP connection      1. bridge checks memory → miss?
 2. resolveSessionId:             2. session/list(dir)            2. look up the map → acpId?
    map lookup → hit? use it        3. take newest titled in dir     ├─ yes → adoption
    : miss? pass it through as      4. dispose that connection       └─ no → §2.3 rules
    agent-native (UUID direct)      5. hand the id pair to the
 3. pre-create the record:            pre-created resume path ★
    key = the raw id typed          ★ = exactly isomorphic to
    acpSessionId = the result         --session! (history loads
 4. ensureSession → eager             before the TUI connects)
    session/load → 177 replayed
    (history loads first)
```

### 2.1 The pre-created record (`ensureSession`)

The bridge guarantees "at least one session" (the TUI's composer is only usable on a session route).
The **key** of the pre-created record:

```typescript
createSession(location, name, resumeVisibleSessionId ?? resumeSession)
//                        ↑ the ses_… the user typed, never the translated UUID
```

★ The old bug: the key was the translated agent id → when the TUI asked with `ses_…` it **missed**
the pre-created record → on to adoption → a second agent process loads the same session → the single writer refuses →
the fallback branch **creates a new session** and passes it off as the resume (the title at the time
said `[not resumed]`). The three-in-one symptom: tab present, title right, content empty.

### 2.1.1 Reusing the pre-created shell (R7)

The pre-created record **is not a session**: it only makes sure the composer has a session route from
the start. It used to cost "one new conversation = two records + two agent processes":

1. `GET /api/session/active` → `ensureSession` pre-creates a shell;
2. `/api/model`, so the catalog is not the placeholder, calls `ensureAgent` on the shell → **the first agent**;
3. the user presses Enter, the TUI itself sends `POST /api/session` (with the id it chose) → a second
   record, the first prompt → **the second agent**.

Now `POST /api/session` **takes over** the shell:

- the shell carries a `precreated` flag; reusable when: it has no messages, nothing is running, and
  the directory is the same (compared by `canonicalPath`);
- on a hit it is **rekeyed** to the id the client chose, and the tables indexed by session id —
  `agents` / `pendingAgents` / `translators` / pending permissions and forms — move with it
  (`rekeySession`) — **the warmed-up agent is kept**;
- **the map has to move too**: the shell had already written the "visible id → agent id" pairing when
  `/api/model` warmed it up; without the move, the pairing still hangs on the shell's id, while the exit line prints the client-chosen id → the
  next `-s` reports `unknown session id` outright. Measured: exactly this cause. `rekeySession` now
  does `forget(old)` + `remember(new, …)`, so one session never has two visible ids;
- result: one record, one agent, one visible id, and the catalog `/api/model` already fetched stays
  valid.

★ A hole we dug ourselves: the first version used `record !== shell` to decide "was the table moved",
but `state.rekey` changes the id in place and
returns the same object → the condition was always false, the agent stayed hung on the old id, the
first prompt found no agent and started another one, and that walked into the resume branch writing the title as `[new conversation] hi`.
**Compare ids, not objects.**

Verified on the real TUI (fake agent): after one turn of a new conversation `/api/session` holds
exactly one entry (title taken from the first sentence), the log has `adopted the pre-created session as …` once and no `cannot resume`.

### 2.2 Why `-c` must be isomorphic to `--session`

Same session, same bridge, both forms measured side by side:

```text
--session ses_xxx: eager load done before the TUI connects → GET /message finds data ready → history shows instantly
-c (old impl)    : TUI navigates first → GET /message hits the 8-second dsh startup → the response does get the data,
                   but the TUI's prefetch snapshot has long since rendered it as empty → history blank
```

So `-c` now queries **the map** directly: the entry for this directory with the newest `updatedAt` that
carries an `agent` is it,
and the agent comes from the entry too (no `--` needed); then it is resolved into a pair of ids and
handed to the pre-created path — **the load happens before the TUI connects**.

★ Rule details (`newestContinueEntry`, a pure function, unit-tested): **filter by directory (realpath),
take the newest by `updatedAt`, require `agent`** (an old entry without one cannot launch, so it is skipped). No entry → **fail outright**:
`no session to continue in <dir>; start a new one with -- <agent>`,
rather than falling back to a blank pre-created session (native `-c` errors out on an empty store and
drops to a draft; we choose the clearer of the two).
Directory comparison goes through **realpath**: on macOS `/var` and `/private/var` are the same place,
and a literal comparison silently finds nothing.

★ When nothing can be continued at all (the agent does not declare `session/list`, or this directory
has no session), the pre-created record's title is written as
`[new conversation] <directory>` — the client's own `-c` lands on it, and without the mark it looks
like "continued a session whose history mysteriously vanished".

### 2.3 Adoption rules (adoption tightened)

When the TUI reopens it requests every tab id in its memory. The bridge's answers come in three kinds:

```text
map hit                       miss, but UUID-shaped       miss, and not a UUID
→ ordinary adoption:          → adopt: take the id as     → 404, refused
  resolve the agent id,         the agent id as-is       (copying a dsh web UI id)
```

★ The 404 is **deliberate**: the old "adopt indiscriminately" rule materialised `ses_…` ids whose map
entry was lost, and even garbage ids (see the dummy in §5) — the load was bound to fail, and the
fallback **created an empty session** that then sat in the tab wearing the real session's name.
Better a 404 that gets dropped than a fake resume.

## 3. `ensureAgent`'s id precedence (★ the single most important rule)

```typescript
// correct (current):
const wanted =
  record.acpSessionId ??                       // the record's own id always wins
  (record.session.id === resumeRecordKey        // only the pre-created record uses the process-level resume id
    ? this.options.resumeSession
    : undefined);

// the once-reversed version (cost: every tab loads the same session):
const wanted = this.options.resumeSession ?? record.acpSessionId;  // ✗
```

The reversed form sends **every** adopted tab to load the process-level resume session:
- the correct tab loads some other session (content in the wrong place);
- the alias tab of the same session collides with the pre-created record's live agent (single writer)
  → resume fails ×N
  → **every collision spawns a fresh empty shell**.

## 4. Deciding and ordering "the newest session"

The semantics of `-c` = the TUI asks `GET /api/session?limit=1&order=desc` and takes the first entry.
The bridge guarantees that entry is a real session:

```text
ordering rule (state.all):
  1. records with messages ALWAYS rank before empty records   ← the pre-created shell (title=directory name) must never be picked by -c
  2. within a group, by time.updated descending
a record that finished loading → state.touch            ← a just-resumed session becomes "newest"
```

★ The old bug: the pre-created empty record had `updated = now` and sorted first → the TUI's `-c`
picked it → a blank session titled after the directory opened, while the real session only appeared
as a tab one second later.

### 4.1 The epilogue's Continue line (three deterministic levels, no guessing; then filtered by "can it be resumed")

★ Candidates are ordered `prompted → intent(--session/-c) → viewed`, but **only an id the next process
can actually resolve is ever printed**:
`firstResolvableSessionId` tries each one through `resolveSessionId` and skips every `ses_…` with no
pairing in the map
(a session that never reached the agent can still count as viewed; printing it guarantees the next
failure).
A native agent UUID passes as before (`-s` allows it, and the agent decides).

On exit the TUI prints `Continue opencode -s <id>` (the native string is hardcoded in the TUI binary).
**After the child process exits** the bridge rewrites that line by ANSI positioning. Which id it
picks — `epilogueSessionId`
(`src/index.ts`, a pure function, unit-tested) — is decided in three levels by **determinism**:

```text
1. prompted  a session really typed into this run   ← recorded by the bridge on the first line of the prompt handler, hardest evidence
2. intent    the session the user asked to resume   ← the id pair resolved from --session <id> / -c
3. viewed    the session the client last read/focused ← GET /api/session/:id, POST /view
all three empty (open, nothing typed, nothing opened) → keep the native line, never invent an id

why this order (each one is a measurement):
  · with "typed into" only, a session resumed and exited without typing has no name → the native line (the first bug reported)
  · with "last read" only, a multi-tab launch counts **another tab** as last read → the wrong name
  · so intent must beat viewed: what the user named ≠ what the client prefetched along the way
line shape: the command as the user typed it + -s <id>
   (an existing --session/-s/-c is replaced in place; if absent, inserted before --;
    the bridge's internal --bridge-* arguments are stripped; a PATH-resolved agent command is
    reduced back to its basename)
how to read it: only the in-memory accessors (`promptedSessionId` / `viewedSessionId`),
   no HTTP at exit — measured: that one collides with the shutdown and comes back null.

acceptance: `bash scripts/e2e-epilogue.sh` (real TUI + tmux + screen assertions, 4 scenarios: resume then no input, intent beats viewed, viewed only, nothing at all).
```

### 4.2 The three resume outcomes (capability decides, the title tells the truth)

`ensureAgent` only calls methods the agent **has declared** — ACP says MUST NOT for both: without
`loadSession` no `session/load`, without `sessionCapabilities.resume` no `session/resume`.
So a resume has exactly three outcomes, and **the title is the only explanation the user can see**
(the client persists it into the tab layout, so the wording must match the facts — `[not resumed]` once declared a successful resume a failure):

| what the agent declares | what we do | tab title | what is on screen |
|---|---|---|---|
| `loadSession` | `session/load`, the replay becomes the transcript | untouched (a title from the agent wins) | history is there |
| `resume` only (dsh's plain `acp` is like this) | `session/resume`: reconnect to the same session, **no history replayed** | keep the **real name** (no marker) | empty (as the spec says), but the session area gains a `◈ Notice`: `Resumed without showing history: this agent "<agent command>" has no session/load capability` — saying plainly that "the agent cannot read the history" instead of letting people think "there is no history". ★ Whether the context is still there is **not guaranteed**: the same profile measured both (after a model switch, one remembered and one did not) — do not write either claim down as fact |
| neither | call neither method, record "cannot resume" honestly, start a new session | `[new conversation] <directory name>` | empty, but plainly a **new conversation** |

★ The marker is **idempotent**: `markTitle` strips the old marker (including the historical `[not resumed]`) before adding the new one,
so repeated resumes never stack up as `[new conversation] [new conversation] …`.

★ The map's write rules (`rememberPairing`):

- on **success** fill in "visible id → agent id". A `ses_acp_…` synthesised by `-c` (coming from the
  agent's own list)
  can only be resolved on the next `-s` thanks to this step — otherwise the id printed back to you is
  judged an "unknown session" next time.
- on the **failure fallback** write the new session only when "this mapping did not exist anyway";
  **existing mappings are left alone**.
  The old session is intact on the agent's side, and the next launch retries it instead of permanently
  repointing it at the new one.

On failure (load / resume throws; the most common measured cause is **another process holding this
session** — single writer) the current run suggests the new session, and the title already says as much.

### 4.3 Where the title comes from (who wins)

ACP has no "client sets the title" method; `session_info_update` runs in the agent's direction. So a
title has four sources, in descending priority:

```text
1. agent         the title of session_info_update / session/list   ← highest, overrides on arrival
2. user rename   PATCH /api/session/:id, POST /rename              ← effective at once; the fallback leaves it alone from then on
3. fallback      the first input (one line, ≤48 chars, … when longer) ← computed once, never recomputed
4. default/mark  the directory name, [new conversation]            ← the look when there is nothing at all (`[no history]`/`[no transcript]` are legacy, and still get stripped)
```

`SessionRecord.titleFromAgent / titleFromUser / titleDerived` are the three flags recording the source,
`deriveTitle` (`src/server.ts`) only acts when all three are false; `derivedTitle` is a pure function
(unit-tested).

★ **Titles are bidirectional: the map stores "the last known name"**: the fallback title, the agent's
`session_info_update` / `session/list` title, and a user rename — **whichever source wins, the current
title is written back to the map**
(`persistTitle`; markers are display decoration and are never written to the map). That way `-s` reads
back the real name instead of the directory name — previously only agent titles entered the map, plain `acp` has no title surface at all, so every resume fell back to `tau`.
The map still **stores no message content**: a title of ≤48 chars is identity, not a log.

★ Why a fallback is mandatory: plain `acp` has no title surface whatsoever (measured: `session_info_update` appeared 0 times),
and without it such sessions sit forever on the client's "New session" — which is exactly the first
thing the owner ever reported.

## 5. The timing traps (each one a measured failure)

```text
trap A — two agent processes collide on the single-writer lock
  eager session/new (the pre-created record) + adoption's session/load (the other path)
  = two dsh processes in one workspace → the second is bound to fail (Internal error)
  ∴ in continue mode the pre-created record stays lazy; never start a second process.

trap B — load hits an agent that is not ready
  in the earliest part of discovery/startup, dsh's store may not be ready → the same load succeeds a moment later.
  ∴ a failed load retries once after 2s; only a second failure falls back (and marks the session title honestly).

trap C — a leftover process holds the lock (environmental)
  tmux kill-session / closing the window used to kill the bridge outright (no SIGHUP handling) → the agent is orphaned
  → every later load must fail, and the symptom looks exactly like a bridge bug.
  ∴ SIGHUP is wired into the shutdown path; when diagnosing "resume comes up blank", ps for orphans first.

trap D — the TUI's -c placeholder "dummy"
  TUI source: -c's initialRoute hardcodes sessionID:"dummy" and only really navigates once the list comes back.
  If the bridge adopts it → it materialises an empty session called dummy. It is 404'd now (§2.3).

trap E — discovery manufactures shells itself
  discovery starts an agent connection to fetch the list, and dsh helpfully does session/new on initialize.
  Measured once: 41 sessions in one workspace, 37 of them shells (90%) — the accumulated pollution of history probing.
  ∴ import titled sessions only (dsh titles a session only after the turn completes, so a shell has none and is
    excluded by nature); after a test you must run the archive script (AGENTS.md §6).
```

## 6. A resume sequence diagram (the current, correct version)

```
oc-acp-client --session ses_AAA -- dsh
   │
   ├─ resolveSessionId(ses_AAA)      map lookup → agent id 91b0…
   ├─ BridgeServer(resumeSession=91b0…, resumeVisibleSessionId=ses_AAA)
   ├─ listen
   ├─ ensureSession                pre-created record, key=ses_AAA
   │     └─ ensureAgent → session/load(91b0…) → 177 entries replayed → record.history ready
   ├─ waitForCatalog               the model catalog arrives
   ├─ launch TUI (--server … --session ses_AAA)
   │     TUI: GET /api/session/ses_AAA      → hits the pre-created record (the key matches!) ✓
   │     TUI: GET /…/ses_AAA/message        → the replayed history renders at once ✓
   └─ user Ctrl-C → SIGHUP/SIGINT → server.close → agent dispose → zero orphans
```

## 7. Multiple tabs: prefetch, lazy loading, and each tab's own agent and model catalog

### 7.1 What native opencode v2 does, and why we do not copy it

Once connected, the native TUI **prefetches everything, staggered**: metadata pulls every remembered tab in parallel immediately; `TAB_PREFETCH_DELAY`
(300ms) later it pulls message / pending / permission / form for **every tab except the current one**,
one after another (`packages/tui/src/context/session-tabs.tsx`). It is cheap because there is **one server process + SQLite**:
one sync is one database read.

Here one "transcript read that needs loading" = **a whole agent process** doing `session/load`/`session/resume`,
and a backend that takes a workspace/session lock (dsh) refuses the second holder outright. So copying
the full prefetch = N agent processes.

### 7.2 Lazy loading: only one transcript loads at a time

The `/message` read path has one gate: **only one transcript load at a time**.

- the visible tab's mount read arrives first (client source comment: the visible session's mount sync
  claims the connection slot first) → it gets the load;
- a background tab's read arriving meanwhile → answered from the existing content, and logged as
  `[bridge] lazy: ses_… answered without loading (ses_… is loading its transcript)`;
- when the user switches over, the client mounts that session and re-reads the transcript → the gate is
  free by then, and only then does the real load happen.

This is not a "compatibility gap" but a **resource policy**: ACP only requires "one holder per session
at a time", not that a client read start a process. Verified on the real TUI (fake agent): reopening
several tabs loads exactly one transcript, and a background tab loads after the switch.

### 7.3 Each tab's own agent (see §1.2)

One bridge can serve several agents at once: a tab's binding comes from the map, and spawning uses its
argv. Every tab is still **started lazily**: an agent is spawned only when that tab really needs one.

### 7.4 The model catalog comes from "the tab in front"

`GET /api/model` carries only `location[directory]`, no session id; but the catalog must come from
**the current tab's agent**: with two tabs bound to dsh and opencode respectively, listing dsh's models
on the opencode tab means
the agent rejects whatever you pick.

So the bridge tracks **the focused session** (`noteFocus`):

- every session-level request (reading a transcript, prompt, model switch, rename) counts as "looking at
  this session";
- but **several different sessions within the same second** count as startup prefetch (the visible tab
  arrives first, the prefetch 300ms later) and **do not change the focus**;
- a human switching tabs always lands after the quiet gap, so it does update the focus (`FOCUS_GAP_MS = 1000`).

`/api/model` builds the catalog from the focused session's agent; with no focus (just started / a new client)
it falls back to "every live agent". On a model switch it then **validates against that session's own catalog**: a model that does not
belong to this agent gets a 400 directly
(`the agent refused the model switch: …` / `… is not offered by this session's agent`),
instead of letting the agent answer with an `Internal error` nobody can read.

★ Known limitation: focus is heuristic (the client sends no session id). Open the picker the instant
after startup and it may still be "the union"; after a human switches tabs it is always right.
Verified on the real TUI (fake agent): with two tabs offering only model-1 / model-2 respectively,
switch to either tab and `/api/model` lists only that one; picking a model across tabs gets a 400.
