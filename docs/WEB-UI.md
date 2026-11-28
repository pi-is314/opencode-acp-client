# How the bridge serves the web UI

opencode v2.2 and later ship a **web UI** — the same interface as the TUI and the desktop, served as
a normal web page. It is worth supporting because it needs nothing installed on the machine a person
is sitting at: open a URL and you are talking to the agent.

The bridge cannot serve it on its own. The page is a compiled bundle, and a bundle shipped inside
this package would be pinned to one opencode release — every upstream change to the interface would
be a release of ours. **So the bridge borrows the bundle from a real `opencode serve` and serves it
from its own origin, next to the routes it already implements.** This page records why that shape was
chosen, what it costs, and the conflicts that had to be settled.

---

## 1. What a real web UI needs from its origin

Measured against `opencode serve` (v2.4.1), listening on a loopback port:

| Request | Answer | Notes |
|---|---|---|
| `GET /` | `200 text/html` | the whole app shell; **no authentication** |
| `GET /_assets/*` | `200`, hashed filenames | the compiled bundle; **no authentication** |
| `GET /site.webmanifest`, `/favicon.ico`, `/robots.txt` | `200` | same public class |
| `GET /api/*` | `200` with `Authorization: Basic …`, **`401` without** | `WWW-Authenticate: Basic realm="Secure Area"` |
| any unknown path | `200 text/html` | SPA fallback — `/ws` and `/pty` answer HTML, not a route |

Two facts decide the design:

★ **The front end talks to `location.origin`.** The bundle resolves its server as
`currentServerUrl: () => location.origin + <prefix>` and its CSP is
`connect-src 'self'`. A page served from `A` therefore cannot be pointed at an API on `B` — no
configuration, no CORS origin, nothing. **The page and the API must share an origin.**

★ **Credentials travel in the URL or the header, never in a cookie.** The server accepts
`Authorization: Basic <base64(user:pass)>` **or** `?auth_token=<the same base64>`
(`packages/server/src/middleware/authorization.ts`); the `opencode pair` link is that query form,
and the bundle strips the parameter once it has read it. Nothing in the exchange is origin-bound
except the page's own `fetch` calls, which are same-origin by construction.

Together: **the bridge has to serve the page from its own origin, and it has to forward the
credentials it is given.** That is what it does.

---

## 2. The shape: one more proxy, off by default

```
browser ──GET /──────────▶ bridge ──plain GET──────────▶ opencode serve (loopback, private)
        ──GET /api/*─────▶ bridge  (its own answer — the page's API is OURS)
        ──GET /_assets/*─▶ bridge ──plain GET──────────▶ opencode serve
```

- **`/api/*` is never proxied.** The page is the client; its API is the bridge's own — the same
  routes the TUI and the desktop use. Proxying them would serve opencode's sessions, not the
  agent's, which is the whole point of this product inverted.
- **Everything else is fetched from the helper**, with its body re-served from our origin. There is
  no caching by the bridge beyond what the helper's own `cache-control` says: the filenames are
  content-hashed, so re-fetching costs one round trip per asset per page load and never serves a
  stale build after an upgrade.
- **Off by default.** Without `--web-proxy <url>` the bridge behaves exactly as before and serves no
  page. A person running the TUI should not have an HTTP server with a browser UI on it that they
  did not ask for.

---

## 3. How the helper is started, and why the bridge does not start it

`--web-proxy <url>` names a **running** `opencode serve`:

```bash
opencode serve --hostname 127.0.0.1 --port 4096 &
oc-acp-client --bridge-port 8765 --web-proxy http://127.0.0.1:4096 . -- qwen --acp
```

★ **The bridge does not spawn the helper.** Spawning it would mean managing a second process's
lifecycle, its port, and its password — and the `opencode` binary the bridge already resolves is the
one it runs the TUI from, whose `serve` may be a different version from the bundle someone wants.
Naming a URL keeps the decision with the person, and keeps one obvious failure ("nothing is
listening there") instead of two ("it did not start" / "it started but the bundle is wrong").

★ **The helper needs no password, and gets none.** It listens on loopback and is reachable only from
this machine; the browser never talks to it. The bridge's own port is the one that faces the
network, and it carries its own authentication (below).

---

## 4. The conflicts, settled

### 4.1 Two servers, one origin

The page is served by the bridge; its API calls land on the bridge. The helper's API is never
reachable through the bridge's origin, so "which server answered `/api/session`" has exactly one
answer. The only thing taken from the helper is static bytes.

### 4.2 Authentication

The page assumes it can authenticate: on a real server every `/api/*` call carries Basic
credentials, and a page that gets `401` shows the sign-in screen. The bridge has no authentication at
all today (see `docs/DESKTOP.md`, `--bridge-host`). **Serving a browser UI on that basis would
publish the agent's execution to anything that can reach the port** — worse than the desktop
situation, because the desktop at least is not a URL a person bookmarks.

So this feature brings a password with it:

- `--web-password <pass>`, or `OPENCODE_WEB_PASSWORD`, is required **when the page is served**.
  Without one, `--web-proxy` is refused at startup with one sentence saying so, because a browser UI
  with no password is the one combination this must not ship.
- The bridge answers `401` with `WWW-Authenticate: Basic realm="Secure Area"` for `/api/*` unless
  the request carries the password — as Basic, or as `?auth_token=<base64("opencode:<pass>")>`, the
  two forms the page and the pair link already use. Implemented to the same rule as the helper, so
  a bundle that works against `opencode serve` works here unchanged.
- **Scope: `/api/*` only.** Static assets stay public, exactly as they are on a real server, so the
  page can paint its sign-in screen. Nothing in an asset is a secret.

### 4.3 The bridge's own clients

The TUI and the desktop **do not send credentials** — they connect over loopback and were verified
that way. Requiring a password for them would break every existing setup.

The line is drawn by where the request came from, not by which client it is:

| Request | Password |
|---|---|
| loopback (`127.0.0.1`, `::1`) | not required |
| anything else | required |

★ That is the same rule the rest of the bridge already lives by: `--bridge-host` defaults to
`127.0.0.1` because there is no auth; the moment it accepts other machines, there is. A TUI on the
same machine keeps working with no configuration, and a browser anywhere else must sign in.

### 4.4 The page's own routes versus ours

The helper answers unknown paths with the SPA fallback (`200 text/html`). The bridge already answers
unknown `/api/*` with a shaped empty envelope — a 200/204 that the TUI expects — and that rule does
not change: **`/api/*` is ours, always.** Outside `/api/*` the fallback is correct and is passed
through; nothing else in the bridge claims those paths.

### 4.5 Streaming

The page opens an event stream. It must be `/api/event` on **our** origin — the bridge's own SSE,
already implemented and already what the TUI and the desktop subscribe to. Nothing to proxy. The
helper's own SSE routes are never reached, which is also why the helper does not need a password: it
serves files and nothing else is asked of it.

★ Verified before relying on it: the bundle's `EventSource` targets the same origin as `fetch`
(`location.origin`), so there is no second, hidden connection to redirect.

---

## 5. Failure behaviour

| Situation | What happens |
|---|---|
| `--web-proxy` unset | no page; every path behaves exactly as before |
| `--web-proxy` set, no password | **refused at startup**, one sentence |
| helper not reachable | `GET /` answers `502` with one line of text; `/api/*` is unaffected — the TUI and the desktop on that bridge keep working |
| helper answers 404 for an asset | that asset is a `404`; the page shows its own broken state |
| helper is a different opencode version | the page loads and talks to **our** API; anything the bundle expects from `/api/*` that we do not answer is the ordinary compatibility question, not this feature's |

★ The third row is deliberate: **a missing helper must not take the bridge down.** The people using
the TUI never asked for a web UI, and the proxy is the part that depends on another process.

---

## 6. What was measured, and with what

`scripts/e2e-web.mjs` — a real `opencode serve` as the helper, the bridge in front of it, and a
headless browser driving the page: sign in if asked, open a session, send a prompt, read the reply
off the screen. It is not part of `pnpm verify` (it needs an `opencode` binary and a browser), and it
says so when either is missing rather than passing quietly.

The lesson from the desktop harness applies here and is why every check in it is graded from the
**screen**, not from the bridge's log: a request that was answered is not a page that rendered, and
three of the desktop's nine failures were the harness asserting on its own assumptions.
