#!/usr/bin/env node
/**
 * opencode desktop (FROM SOURCE) against this bridge, over CDP — one uninterrupted run.
 *
 * ★ Why from source. The packaged app cannot be driven or isolated:
 *   - its bundle has `EnableNodeCliInspectArguments: Disabled` (read with `@electron/fuses`) and
 *     `environment.ts` only appends `remote-debugging-port` when `!app.isPackaged`, so a release
 *     build never opens a CDP endpoint (measured: five launch shapes, none opened 9223);
 *   - its local service is `defaultPort()`'s 0xc0de = 49374 for channel `latest`, and the
 *     single-instance lock is scoped to userData, so a second desktop collides on the port;
 *   - `--user-data-dir` is overwritten by `app.setPath("userData", …)`.
 *
 * `bun run dev:desktop` (`packages/desktop/scripts/dev.ts`) fixes all three: channel `local`
 * (service port 49375), `OPENCODE_DESKTOP_ISOLATED_SERVER=1` (random service port), and an
 * UNPACKAGED Electron — debug port 9222, userData `ai.opencode.desktop.dev`. Nothing of the
 * user's own desktop is touched.
 *
 * ★ The two mistakes that cost a run each, kept as warnings:
 *   1. The agent command must be an ABSOLUTE path. The bridge runs in a temp cwd, so
 *      `node tests/fake-acp-agent.mjs` becomes `<tmp>/tests/…` and the agent dies instantly —
 *      which the desktop renders as a crashed app, looking like a desktop bug.
 *   2. The bridge spawns the agent LAZILY, so `/api/model` is the placeholder until a session
 *      exists. Create the session first, then read the catalog.
 *
 *   node scripts/e2e-desktop.mjs
 *   OPENCODE_REPO=/path/to/opencode node scripts/e2e-desktop.mjs
 *   KEEP=1 node scripts/e2e-desktop.mjs      # leave the dev desktop running
 *
 * ★ STATUS (measured 2026-11-27, on `feat/opencode-desktop` rebased onto main): SEVEN checks pass —
 * the bridge serves, the dev desktop opens over CDP, the bridge is added as a server through its
 * real UI, and the sidebar lists it. The last two fail: no conversation appears, because the
 * desktop never asks the bridge for `/api/session`.
 *
 * ★ What the desktop DOES ask the bridge for: `/api/health`, `/api/location`, `/api/vcs`,
 * `/api/project`, `/api/session/active` — every one answers 200 with correct data
 * (`/api/project` returns `{id, directory, canonical, worktree, expanded}`, the shape
 * `LocalProject = Partial<Project> & { worktree: string }` requires). The list query lives in
 * `home/sessions/controller.tsx` behind `enabled: !!ctx && connection.status() === "connected"`
 * and `const selected = home.selection.value().directory; if (!selected) return`.
 *
 * ★ Ruled out by measuring, not by reasoning:
 *   - **Not the bridge.** Every route it is asked for answers correctly, verified with `curl`.
 *   - **Not the click target.** `HomeProjectNavButton`'s onClick is `onFocusServer`, and the row's
 *     first button IS that control (its inner span is the collapse chevron). Clicking it leaves
 *     `data-selected` on the LOCAL server row; a MutationObserver saw no flip at all.
 *   - **Not the persisted state.** Writing `home.selection.{server,directory}` into
 *     `opencode.global.dat:layout` and `projects[<bridge url>]` into `opencode.global.dat:server`
 *     survives a reload (read back verbatim, `serverList` included) and still shows the empty
 *     state — with 12s and with 25s.
 *   - **Not a directory mismatch.** The directory written is the one `/api/location` answers with,
 *     which is the one the session lives in.
 *
 * ★ What is left, and why this script stops here: the desktop's project tree is the CLIENT's own
 * persisted list (`createServerProjects`, `runtime/server/registry.tsx`); `/api/project` supplies
 * candidates only. A project enters that list through `home.project.add`, whose only UI route is
 * `choose()` → `pickDirectory()` → `platform.openDirectoryPickerDialog` — a NATIVE macOS dialog,
 * behind an IPC `MessagePort` the page cannot intercept. Closing it needs a stub for that port or
 * a desktop build with a non-native picker; neither belongs in a bridge repository.
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const ENTRY = join(ROOT, 'dist', 'index.js');
const FAKE_AGENT = join(ROOT, 'tests', 'fake-acp-agent.mjs');
const REPO = process.env.OPENCODE_REPO ?? join(process.env.HOME ?? '', 'PycharmProjects', 'opencode');
const DESKTOP_DIR = join(REPO, 'packages', 'desktop');
const DEV_APP = join(DESKTOP_DIR, 'node_modules', '.cache', 'opencode-dev');
const DEBUG_PORT = Number(process.env.DESKTOP_DEBUG_PORT ?? 9222);
/** A non-loopback address of this machine; the desktop treats such a server as remote. */
const BRIDGE_HOST = process.env.BRIDGE_HOST ?? '10.249.91.185';

let failed = 0;
let passed = 0;
const ok = (what) => {
  passed += 1;
  console.log(`  ✓ ${what}`);
};
const bad = (what) => {
  failed += 1;
  console.error(`  ✗ ${what}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pidsMatching(pattern) {
  try {
    return execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => pattern.test(line))
      .map((line) => Number(line.split(/\s+/)[0]))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    return [];
  }
}

function killPids(pattern, label) {
  const pids = pidsMatching(pattern);
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
  if (pids.length) console.log(`  … killed ${pids.length} ${label}`);
}

async function waitFor(check, timeoutMs, stepMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check().catch(() => undefined);
    if (value) return value;
    await sleep(stepMs);
  }
  return undefined;
}

/**
 * CDP over one websocket. `evaluate(body)` runs `body` as the body of an async function, so
 * `return expr` works; a bare expression would come back undefined.
 */
class Cdp {
  #ws;
  #id = 1;
  #pending = new Map();

  static async attach(port) {
    const target = await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${port}/json`);
      const list = await response.json();
      return list.find((entry) => entry.type === 'page' && 'webSocketDebuggerUrl' in entry);
    }, 120_000);
    if (!target) return undefined;
    const client = new Cdp();
    client.#ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      client.#ws.onopen = resolve;
      client.#ws.onerror = reject;
    });
    client.#ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      const entry = client.#pending.get(message.id);
      if (!entry) return;
      client.#pending.delete(message.id);
      entry(message.result);
    };
    return client;
  }

  /** Any CDP method, not just Runtime.evaluate — the emulation commands live here. */
  call(method, params = {}) {
    const id = this.#id++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CDP ${method} timed out`)), 30_000);
      this.#pending.set(id, (result) => {
        clearTimeout(timer);
        if (result?.error) reject(new Error(`${method}: ${result.error.message}`));
        else resolve(result?.result);
      });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  eval(body) {
    const id = this.#id++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP evaluate timed out')), 120_000);
      this.#pending.set(id, (result) => {
        clearTimeout(timer);
        if (result?.exceptionDetails) {
          reject(new Error(result.exceptionDetails.exception?.description ?? 'evaluation threw'));
          return;
        }
        resolve(result?.result?.value);
      });
      this.#ws.send(
        JSON.stringify({
          id,
          method: 'Runtime.evaluate',
          params: { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true },
        }),
      );
    });
  }

  close() {
    try {
      this.#ws?.close();
    } catch {
      /* ignore */
    }
  }
}

/** The whole UI walk, in ONE evaluate, so no intermediate state can be observed or raced. */
const ADD_SERVER = (url) => `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const text = (el) => (el.innerText || '').trim();
  const click = (el) => {
    for (const type of ['pointerdown', 'pointerup']) el.dispatchEvent(new PointerEvent(type, { bubbles: true }));
    el.click();
  };

  // ★ THE ORDER MATTERS. Clicking 设置/Preferences lands on the General tab, never on the
  // servers tab — so "wait for the servers panel" never becomes true and every attempt burned its
  // whole timeout before the nav click was reached. The sequence is: open settings, click the
  // 服务器 nav, THEN wait for that panel.
  const panelUp = () =>
    !!document.querySelector('.settings-servers-header, [class*="settings-servers"]') ||
    [...document.querySelectorAll('button')].some((b) => text(b) === '添加服务器');

  if (!panelUp()) {
    // 1. open settings: the button is 设置 in a Chinese locale and Preferences in an English one,
    //    and there are two of them.
    for (const candidate of [...document.querySelectorAll('button')].filter((b) => /^(设置|Preferences)$/.test(text(b)))) {
      click(candidate);
      // wait only for SETTINGS CHROME here — the nav is what tells us we arrived
      for (let i = 0; i < 16 && !document.querySelector('[class*="settings-nav"]'); i++) await sleep(500);
      if (document.querySelector('[class*="settings-nav"]')) break;
    }
    // 2. the 服务器 nav item
    const nav = [...document.querySelectorAll('button')].find((b) => text(b) === '服务器');
    if (!nav) return 'no 服务器 nav';
    click(nav);
    for (let i = 0; i < 24 && !panelUp(); i++) await sleep(500);
    if (!panelUp()) return 'servers panel did not open';
  }
  // 3. the page's own 添加服务器 → menu 添加服务器
  const add = [...document.querySelectorAll('button')].find((b) => text(b) === '添加服务器');
  if (!add) return 'no 添加服务器 button';
  click(add);
  await sleep(900);
  const menu = document.querySelector('[role=menu]');
  const item = menu ? [...menu.querySelectorAll('[role=menuitem]')].find((i) => text(i) === '添加服务器') : undefined;
  if (!item) return 'no 添加服务器 menu item';
  click(item);
  await sleep(1000);
  // 4. fill and submit
  const input = [...document.querySelectorAll('input')].find((i) => (i.placeholder || '').includes('http'));
  if (!input) return 'no URL input';
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, ${JSON.stringify(url)});
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(500);
  const dialog = document.querySelector('[role=dialog],[aria-modal=true]') || document.body;
  const submit = [...dialog.querySelectorAll('button')].find((b) => text(b) === '添加服务器');
  if (!submit) return 'no submit';
  click(submit);
  // wait until the dialog is gone AND a row for this URL exists
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    if (document.body.innerText.includes(${JSON.stringify(url.replace(/^https?:\/\//, ''))})) break;
  }
  await sleep(1500);
  return 'added';
`;

/**
 * Remove the server entry this run added. ★ Without this every run leaves one behind, and a pile
 * of dead `127.0.0.1:<port>` entries makes the app sit on "加载中" for every later run — measured
 * after four accumulated entries.
 */
const REMOVE_SERVER = (url) => `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const text = (el) => (el.innerText || '').trim();
  const click = (el) => {
    for (const type of ['pointerdown', 'pointerup']) el.dispatchEvent(new PointerEvent(type, { bubbles: true }));
    el.click();
  };
  const ready = () =>
    !!document.querySelector('.settings-servers-header, [class*="settings-servers"]') ||
    [...document.querySelectorAll('button')].some((b) => text(b) === '添加服务器');

  // ★ Reload first. The app is in whatever state the run left it (a session view, a stalled
  // settings page), and a reload is the only thing that reliably returns it to the project list —
  // measured: without it the cleanup reported "servers panel never opened" and left the entry
  // behind, and a leftover dead entry is exactly what makes the NEXT run list no sessions.
  location.hash = '';
  location.reload();
  await sleep(9000);

  // Same order as ADD_SERVER: open settings, then click the 服务器 nav, THEN wait for the panel.
  if (!ready()) {
    for (const candidate of [...document.querySelectorAll('button')].filter((b) => /^(设置|Preferences)$/.test(text(b)))) {
      click(candidate);
      for (let i = 0; i < 16 && !document.querySelector('[class*="settings-nav"]'); i++) await sleep(500);
      if (document.querySelector('[class*="settings-nav"]')) break;
    }
    const nav = [...document.querySelectorAll('button')].find((b) => text(b) === '服务器');
    if (!nav) return 'no 服务器 nav';
    click(nav);
    for (let i = 0; i < 24 && !ready(); i++) await sleep(500);
    if (!ready()) return 'servers panel never opened';
  }
  const label = ${JSON.stringify(url.replace(/^https?:\/\//, ''))};
  const row = [...document.querySelectorAll('[class*="settings-servers-row"]')].find((r) => (r.innerText || '').includes(label));
  if (!row) return 'row not found';
  const kebab = row.querySelector('button[aria-label="更多选项"]');
  if (!kebab) return 'no kebab';
  click(kebab);
  await sleep(900);
  const menu = document.querySelector('[role=menu]');
  const del = menu ? [...menu.querySelectorAll('[role=menuitem]')].find((i) => /删除|移除|Remove/.test(text(i))) : undefined;
  if (!del) return 'no delete item';
  click(del);
  await sleep(2000);
  return 'removed';
`;

async function main() {
  console.log('opencode desktop (FROM SOURCE) × this bridge, over CDP');

  if (!existsSync(join(DESKTOP_DIR, 'node_modules'))) {
    console.log(`  SKIP  ${DESKTOP_DIR} has no node_modules — run \`bun install\` in ${REPO}`);
    return 0;
  }

  // A dev instance left over from an earlier run holds 9222 and the dev userData.
  killPids(/opencode-dev\/.+OpenCode Dev\.app\/Contents\/MacOS/, 'stale dev app');
  killPids(/electron-vite/, 'stale electron-vite');
  await sleep(2000);

  const workDir = mkdtempSync(join(tmpdir(), 'oac-desktop-'));
  let bridge;
  let cdp;
  let serverUrl;
  try {
    // ---- bridge. The agent path MUST be absolute: the bridge runs in workDir.
    const port = 9500 + Math.floor(Math.random() * 400);
    bridge = spawn(
      process.execPath,
      // ★ Bind a NON-loopback address on purpose. `directoryPickerKind` makes the picker native
      // only for a server whose host is `localhost` or `127.0.0.1`; on anything else it opens the
      // web dialog, which CDP can drive. A bridge on the LAN address is therefore the one
      // configuration where "add this project" is reachable from a test at all.
      [
        ENTRY,
        '--no-tui',
        '--bridge-host', BRIDGE_HOST,
        '--bridge-port', String(port),
        workDir,
        '--', process.execPath, FAKE_AGENT,
      ],
      {
        cwd: workDir,
        env: { ...process.env, FAKE_ACP_MODELS: '1', FAKE_ACP_REPLY: 'desktop-e2e-reply' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let bridgeLog = '';
    bridge.stdout.on('data', (chunk) => (bridgeLog += chunk));
    bridge.stderr.on('data', (chunk) => (bridgeLog += chunk));
    const bridgeUrl = await waitFor(async () => /"url":"(http:\/\/[^"]+)"/.exec(bridgeLog)?.[1], 90_000);
    if (!bridgeUrl) throw new Error(`bridge never reported a ready line:\n${bridgeLog.slice(-800)}`);
    console.log(`  … bridge on ${bridgeUrl}`);
    serverUrl = bridgeUrl;

    // The agent is spawned lazily, so create a session before reading the catalog.
    const created = await fetch(`${bridgeUrl}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ directory: workDir }),
    });
    if (!created.ok) bad(`POST /api/session answered ${created.status}`);
    const models = ((await (await fetch(`${bridgeUrl}/api/model`)).json()).data ?? []).filter(
      (model) => model.providerID && model.providerID !== 'acp',
    );
    models.length ? ok(`bridge answers with ${models.length} real models`) : bad('bridge still has only the placeholder model');
    const session = ((await (await fetch(`${bridgeUrl}/api/session`)).json()).data ?? [])[0];
    if (!session) throw new Error('the bridge has no session to open');

    // ★ Give the session a model before the desktop sees it. With no selection the composer
    // shows 选择模型 and the send button does NOTHING — measured: the prompt never reached the
    // bridge, the message sat in the UI, and there was no error anywhere. The picker only fills
    // once the catalog and the selection agree, which is why this is done through the API the
    // bridge already serves rather than by clicking.
    const chosen = models[0];
    if (chosen) {
      const selected = await fetch(`${bridgeUrl}/api/session/${session.id}/model`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: { providerID: chosen.providerID, modelID: chosen.modelID ?? chosen.id } }),
      });
      selected.status === 204
        ? ok(`selected ${chosen.providerID}/${chosen.modelID ?? chosen.id} on the session`)
        : bad(`POST model answered ${selected.status}`);
    }

    // ---- dev desktop
    // ★ Start from a CLEAN profile. The dev desktop keeps its added servers, and every run that
    // adds one and fails to remove it leaves a dead `127.0.0.1:<port>` behind — measured: twelve
    // accumulated entries, each polled every few seconds, drowning the log noise that matters and
    // making "which server is focused" unreadable. Wiping the profile before launch is the only
    // way to guarantee the run sees exactly one bridge plus the desktop's own local server.
    // The profile is the UNPACKAGED dev one (`ai.opencode.desktop.dev`); the user's installed
    // desktop (`ai.opencode.desktop`) is never touched.
    const devProfile = join(process.env.HOME ?? '', 'Library', 'Application Support', 'ai.opencode.desktop.dev');
    if (!process.env.KEEP_PROFILE) {
      try {
        rmSync(devProfile, { recursive: true, force: true });
        console.log(`  … wiped the dev desktop profile (${devProfile})`);
      } catch (error) {
        console.log(`  ! could not wipe the dev profile: ${String(error)}`);
      }
    }

    const dev = spawn('bun', ['run', 'dev:desktop'], {
      cwd: REPO,
      env: { ...process.env },
      stdio: 'ignore',
      detached: true,
    });
    dev.unref();
    cdp = await Cdp.attach(DEBUG_PORT);
    if (!cdp) throw new Error(`the dev desktop's CDP port ${DEBUG_PORT} never opened`);
    ok('source desktop reachable over CDP');
    // ★ Let the freshly launched app finish starting before touching its UI. Measured: a desktop
    // that had been running for a while asked for `GET /api/session?limit=5000…` and listed the
    // conversation, while a desktop touched straight after launch reached `/api/project` and
    // stopped — the same bridge, the same click, only the age of the app differed.
    await sleep(Number(process.env.DESKTOP_SETTLE_MS ?? 15_000));

    // ★ The app restores the view it was last on, and stores that as a URL under
    // `opencode.desktop.window.<id>.last-active-url`. A previous run leaves a session URL whose
    // bridge is long gone, and the app then shows that dead session INSTEAD of the project list —
    // with no settings button anywhere, because it is a session view. Clearing the key is what
    // makes the run repeatable; measured: without it every later launch looked "stuck".
    await cdp.eval(`
      for (const key of Object.keys(localStorage)) {
        if (key.endsWith('.last-active-url')) localStorage.removeItem(key);
      }
      return 'cleared';
    `);
    await cdp.eval('location.reload(); return 1;');
    await sleep(20_000);

    // ★ The desktop PROBES a new server (`/api/health`) before it will ever ask for sessions.
    // Measured: the run that listed a conversation showed `health, health, event, location,
    // project, session/active, … project, session?limit=5000`, while the failing run reached
    // `/api/project` without that probe first and never sent `/api/session` at all. So make sure
    // the probe can succeed before the UI is touched: the bridge must be answering, and the URL
    // the UI is given must be the one it answers on.
    const probe = await fetch(`${bridgeUrl}/api/health`).catch(() => undefined);
    probe?.ok ? ok('the bridge answers its health probe') : bad(`health probe answered ${probe?.status ?? 'nothing'}`);

    const added = await cdp.eval(ADD_SERVER(bridgeUrl));
    added === 'added' ? ok('added the bridge as a server through the UI') : bad(`add server: ${added}`);

    // ★ THE SERVERS LIST AND THE PROJECT LIST ARE DIFFERENT SCREENS. Adding a server leaves the
    // settings view up; the sidebar's project tree is only built after going back, and the
    // session list is fetched when the server's group is expanded. Measured: a single click
    // straight after "added" hit an empty tree, while the same click after the tree had painted
    // listed the session. So: go back, wait for the row to appear, then expand it — polling the
    // WHOLE path each attempt so a slow paint cannot be mistaken for a missing session.
    // ★ Built from the URL the bridge actually serves: the harness binds a NON-loopback address on
    // purpose (`directoryPickerKind` opens the web picker only for a remote server), so a hardcoded
    // `127\.0\.0\.1:\d+` matched nothing while the row was right there on screen.
    const bridgeHost = new URL(bridgeUrl).host;
    const sidebarRow = new RegExp(bridgeHost.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    await cdp.eval(`
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const text = (el) => (el.innerText || '').trim();
      const click = (el) => {
        for (const type of ['pointerdown', 'pointerup']) el.dispatchEvent(new PointerEvent(type, { bubbles: true }));
        el.click();
      };
      for (const b of [...document.querySelectorAll('button')].filter((x) => /^(Back to app|返回应用)$/.test(text(x)))) {
        click(b);
        await sleep(1200);
      }
      return 'back';
    `);
    const rowPainted = await waitFor(async () => {
      const body = await cdp.eval('return document.body.innerText;');
      return typeof body === 'string' && sidebarRow.test(body) ? body : undefined;
    }, 30_000);
    rowPainted ? ok('the sidebar lists the new server') : bad('the sidebar never listed the new server');

    // ★ CLICK THE BRIDGE'S ROW — this is what selects the server, and the session query is gated
    // on a selection, not on the row existing. Measured by hand in the same desktop: adding the
    // server left `selected: false` on the bridge row until that row was clicked, and only then did
    // `/api/session` run against it. Writing `home.selection` into localStorage (the fallback below)
    // looked right on read-back and still left the row unselected, so runtime state is what counts.
    const selected = await cdp
      .eval(`
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const want = ${JSON.stringify(bridgeHost)};
        const click = (el) => {
          for (const type of ['pointerdown', 'pointerup']) el.dispatchEvent(new PointerEvent(type, { bubbles: true }));
          el.click();
        };
        const rows = [...document.querySelectorAll('[data-action="home-project-new-session"], [data-action="home-server-collapse"], button')];
        const row = rows.find((el) => (el.innerText || '').includes(want));
        if (!row) return { clicked: false, reason: 'row not found' };
        click(row);
        await sleep(3000);
        return { clicked: true, text: (row.innerText || '').slice(0, 40) };
      `)
      .catch((error) => ({ error: String(error) }));
    console.log('  … clicked the bridge row:', JSON.stringify(selected));
    await sleep(6000);

    // ★ Let the app SETTLE before expanding. Measured side by side: adding the server, waiting,
    // and THEN clicking the group made the desktop fetch
    // `GET /api/session?limit=5000&order=desc&parentID=null` and list the conversation; clicking
    // the group as soon as the row painted never produced that request at all. The row is drawn
    // from `/api/project` while the session list is a separate, later query.
    await sleep(8000);

    // ★ Log what the bridge actually receives while the group is being expanded — the difference
    // between "the desktop never asked" and "the desktop asked and got nothing" is invisible from
    // the UI, and it decides whether the fault is here or in the bridge.
    const bridgeRoutes = () => (bridgeLog.match(/\[http\] (?:GET|POST) \/api\/[a-z\/_0-9.-]*/g) ?? []).slice(-12);

    // ★ Diagnostic, not an assertion: what the DESKTOP believes. The bridge's request log shows
    // /api/health succeeding repeatedly yet no /api/event at all, and the session query is gated on
    // `connection.status() === "connected"`, which the FIRST SSE frame (`server.connected`) sets.
    // If the stream is never opened the gate never opens, and no amount of waiting helps. Print the
    // app-side evidence (resource timing) so a fix targets the right side of the wire.
    const appSide = await cdp.eval(`
      const entries = performance.getEntriesByType('resource').map((e) => String(e.name));
      // Keep the ORIGIN: the question is which server the app is talking to, and a path alone
      // cannot answer it. Measured here first: the app listed /api/session calls while the bridge
      // logged none, which reads as "the desktop never asked" until the origin is printed.
      const origins = Array.from(new Set(entries.map((n) => n.split('/').slice(0, 3).join('/'))));
      const apiCalls = Array.from(new Set(entries.filter((n) => n.indexOf('/api/') >= 0))).slice(-16);
      return {
        origins,
        apiCalls,
        eventStreams: entries.filter((n) => n.indexOf('/api/event') >= 0).length,
      };
    `);
    console.log('  … app side:', JSON.stringify(appSide));

    // ★ Leave exactly ONE server in the sidebar before trying to expand the bridge's group.
    // `dev:desktop` always starts a local server of its own (OPENCODE_DESKTOP_ISOLATED_SERVER=1),
    // so two rows of the same `127.0.0.1:<port>` shape exist and a click aimed at "the" row is a
    // coin flip — measured across runs: one landed on the local server (whose session list is
    // empty, so the conversation never appeared) and the next did not land at all. Removing the
    // local one makes the click deterministic and is closer to the real path anyway: a user who
    // added this bridge and nothing else sees one row.
    const bridgeOrigin = new URL(bridgeUrl).origin;
    const bridgeHostPort = bridgeOrigin.replace(/^https?:\/\//, '');
    // ★ Read the rows the sidebar ACTUALLY shows, not the resource-timing origins: the bridge is
    // added after that snapshot is taken, so it is missing from `appSide.origins` and the filter
    // let it through — the run deleted its own bridge and then asked why nothing listed.
    const shownRows = await cdp
      .eval(`
        return [...document.querySelectorAll('[class~="group/server"]')]
          .map((r) => (r.innerText || '').trim().split('\n')[0])
          .filter((row) => row.includes('127.0.0.1:'));
      `)
      .catch(() => []);
    const others = (shownRows ?? [])
      .filter((row) => !String(row).includes(bridgeHostPort))
      .map((row) => `http://${String(row).replace(/^https?:\/\//, '')}`)
      .filter((o, i, all) => all.indexOf(o) === i);
    for (const origin of others) {
      // ★ `REMOVE_SERVER` ends in `location.reload()`, which destroys the execution context the
      // evaluate promise was resolved from — so the call resolves to `undefined` no matter what the
      // script returned. Judge the OUTCOME from the DOM afterwards instead of from the return value;
      // an earlier version printed "undefined" and read as a failed removal when the row was gone.
      await cdp.eval(REMOVE_SERVER(origin)).catch(() => undefined);
      await sleep(9000);
      const left = await cdp
        .eval(`
          return new Promise((resolve) => setTimeout(() => {
            const rows = [...document.querySelectorAll('[class~="group/server"]')].map((r) => (r.innerText || '').trim().split('\n')[0]);
            resolve(rows);
          }, 2000));
        `)
        .catch(() => []);
      const stillThere = (left ?? []).some((row) => String(row).includes(origin.replace(/^https?:\/\//, '')));
      console.log(`  … removed the desktop's own server ${origin}: ${stillThere ? 'STILL LISTED' : 'gone'}`);
    }

    // ★ Which server the app has FOCUSED, read from its own persisted state. `focusedServer` is
    // `visible.find(key === selection.server) ?? visible[0]`, and `visible` is insertion-ordered
    // with the dev desktop's own local server added first — so unless a selection names the bridge
    // explicitly, every home-session query is aimed at the LOCAL server and the bridge is never
    // asked for `/api/session` at all. That is the hypothesis this print tests.
    const focused = await cdp
      .eval(`
        // The keys are opencode.global.dat / opencode.workspace.<dir>.<sum>.dat, not anything
        // containing "server" — filtering by substring found nothing and printed {}.
        const dump = { keys: [] };
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          dump.keys.push(key);
          if (key.indexOf('opencode.global') >= 0) {
            const raw = localStorage.getItem(key) ?? '';
            try {
              const parsed = JSON.parse(raw);
              dump.global = {
                servers: (parsed.servers?.list ?? []).map((x) => x?.http?.url ?? x),
                hidden: parsed.servers?.hidden ?? null,
              };
            } catch (error) { dump.global = { raw: raw.slice(0, 300) }; }
          }
        }
        return dump;
      `)
      .catch((error) => ({ error: String(error) }));
    console.log('  … persisted:', JSON.stringify(focused).slice(0, 900));



    // ★ Did the click FOCUS the bridge? `home.selection.focusServer(conn)` is what sets
    // `selection().server`, and `focusedServer` is `visible.find(key === selection.server) ??
    // visible[0]` — so an unfocused bridge means every home-session query goes to the desktop's
    // own local server. Asking the bridge for `/api/session` after the click is the direct test:
    // it either arrived or it did not.
    // ★ `/api/session/active` and `/api/session?limit=…` are different requests; a pattern that
    // accepts both reports a hit for the one that is always sent. Match the list route exactly.
    // ★ Which row is SELECTED, straight from the DOM: `HomeServerRow` renders
    // `data-selected` on both the row and its nav button, so this answers "did the click focus it"
    // without needing the app's internal signals.
    const selectionNow = await cdp
      .eval(`
        const rows = [...document.querySelectorAll('[class~="group/server"]')];
        return rows.map((r) => ({
          label: (r.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 60),
          selected: r.hasAttribute('data-selected') || !!r.querySelector('[data-selected]'),
        }));
      `)
      .catch((error) => ({ error: String(error) }));
    console.log('  … sidebar rows:', JSON.stringify(selectionNow));

    // ★ Ask the RENDERER to do what the app's health probe does. `home.projects.view` disables the
    // server row's click when `!healthy() && !authentication()`, so a probe that fails for a reason
    // our own `curl` cannot see (an SDK schema check, a header, a URL shape) leaves the row
    // unclickable — and the click then does nothing at all, which is exactly what was measured.
    const rendererHealth = await cdp
      .eval(`
        const want = ${JSON.stringify(bridgeUrl)};
        const out = {};
        try {
          const response = await fetch(want + '/api/health');
          out.status = response.status;
          out.body = await response.json();
        } catch (error) { out.error = String(error); }
        return out;
      `)
      .catch((error) => ({ error: String(error) }));
    console.log('  … renderer fetch(/api/health):', JSON.stringify(rendererHealth));

    // ★ What the row actually contains, so the click can aim at the element that carries the
    // focus handler instead of guessing by tag name. Printed once per run, kept as a record.
    const rowMarkup = await cdp
      .eval(`
        const want = ${JSON.stringify(bridgeUrl)};
        const hostPort = want.slice(want.indexOf('//') + 2);
        const row = [...document.querySelectorAll('[class~="group/server"]')].find(
          (r) => (r.innerText || '').indexOf(hostPort) >= 0,
        );
        if (!row) return { error: 'row not found' };
        const buttons = [...row.querySelectorAll('button')].map((b) => ({
          cls: b.className.slice(0, 80),
          disabled: b.disabled,
          text: (b.innerText || '').trim().slice(0, 20),
          actions: [...b.querySelectorAll('[data-action]')].map((x) => x.getAttribute('data-action')),
        }));
        return { buttons };
      `)
      .catch((error) => ({ error: String(error) }));
    console.log('  … bridge row buttons:', JSON.stringify(rowMarkup));

    const flips = await cdp.eval('return (globalThis).__flips ?? null;').catch(() => null);
    if (flips) console.log(`  … the bridge row's data-selected flips after the click: ${JSON.stringify(flips)}`);

    // ★ Fallback path, tried only when the click left the app focused elsewhere: write the
    // selection the app would have written. `ServerConnection.key(conn)` for an http server is
    // simply `conn.http.url`, and the layout persists `home.selection.server` under
    // `Persist.global("layout")`. Setting it and reloading reproduces "the user clicked the bridge
    // and the choice stuck" without depending on where the click handler sits.
    const stillLocal = (selectionNow ?? []).every(
      (row) => !String(row.label).includes(new URL(bridgeUrl).host) || row.selected !== true,
    );
    if (stillLocal) {
      const bridgeLocation = await fetch(`${bridgeUrl}/api/location`)
        .then((r) => r.json())
        .then((b) => b.directory)
        .catch(() => undefined);
      const dirLiteral = JSON.stringify(bridgeLocation ?? '');
      const pageScript =
        'const want = ' + JSON.stringify(bridgeUrl) + ';\n' +
        'const dir = ' + JSON.stringify(bridgeLocation ?? '') + ';\n' +
        'const layoutKey = ' + JSON.stringify('opencode.global.dat:layout') + ';\n' +
        'const serverKey = ' + JSON.stringify('opencode.global.dat:server') + ';\n' +
        'let layout = {};\n' +
        'try { layout = JSON.parse(localStorage.getItem(layoutKey) || "{}"); } catch (e) { layout = {}; }\n' +
        'const prev = (layout.home || {}).selection || {};\n' +
        'layout.home = Object.assign({}, layout.home || {}, {\n' +
        '  selection: Object.assign({}, prev, { server: want, directory: dir }),\n' +
        '});\n' +
        'localStorage.setItem(layoutKey, JSON.stringify(layout));\n' +
        'let state = {};\n' +
        'try { state = JSON.parse(localStorage.getItem(serverKey) || "{}"); } catch (e) { state = {}; }\n' +
        // ★ Merge, never replace: ServerState requires list/hidden/projects/lastProject/recentlyClosed,
        // and a partial object fails the schema decode so the whole store falls back to defaults —
        // which silently discarded the project entry this code had just written.
        // ★ Keep the EXISTING list. Defaulting it to [] wiped the server entries (measured:
        // serverList came back empty, so `servers.visible` was empty, `focusedServer` resolved to
        // undefined and nothing loaded at all). If the stored list is empty, seed it with this
        // bridge so the app has something to focus.
        'state = Object.assign({ hidden: {}, projects: {}, lastProject: {}, recentlyClosed: {} }, state);\n' +
        'if (!Array.isArray(state.list) || state.list.length === 0) {' +
        '  state.list = [{ type: "http", http: { url: want } }];' +
        '}\n' +
        'state.projects = Object.assign({}, state.projects);\n' +
        'state.projects[want] = dir ? [{ worktree: dir, expanded: true }] : [];\n' +
        'localStorage.setItem(serverKey, JSON.stringify(state));\n' +
        'return { layout: layout.home.selection, projects: state.projects[want] };\n';
      const forced = await cdp.eval(pageScript).catch((error) => ({ error: String(error) }));
      console.log('  … forced selection write:', JSON.stringify(forced));
      await cdp.eval('location.reload(); return 1;').catch(() => undefined);
      await sleep(12000);
    }

    // ★ What the sidebar shows AFTER the selection took effect. The session query now reaches the
    // bridge (measured: /api/session, then /api/session/<id>), so if the row still is not on screen
    // the block is downstream of the fetch and the text is worth reading before guessing.
    const sideText = await cdp
      .eval('return (document.body.innerText || "").slice(0, 1200);')
      .catch((error) => String(error));
    console.log('  … body text:', JSON.stringify(String(sideText).slice(0, 900)));

    // ★ What the app actually has in storage now (keys AND the server-state slice), after the
    // reload had a chance to read it back. Prints rather than asserts: this is the difference
    // between "we wrote the wrong key" and "the app read it and rejected the shape".
    const storedNow = await cdp
      .eval(
        'const keys = [];' +
        'for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i));' +
        'const raw = localStorage.getItem("opencode.global.dat:server");' +
        'let parsed = null;' +
        'try { parsed = JSON.parse(raw || "null"); } catch (e) { parsed = String(e); }' +
        'let layout = null;' +
        'try { layout = JSON.parse(localStorage.getItem("opencode.global.dat:layout") || "null"); } catch (e) {}' +
        'return {' +
        '  keys: keys,' +
        '  serverKeys: parsed && parsed.projects ? Object.keys(parsed.projects) : null,' +
        '  selection: layout && layout.home ? layout.home.selection : null,' +
        '  serverList: parsed && parsed.list ? parsed.list.map((x) => (x && x.http ? x.http.url : x)) : null,' +
        '};',
      )
      .catch((error) => ({ error: String(error) }));
    console.log('  … stored after reload:', JSON.stringify(storedNow).slice(0, 700));

    const sessionHits = (bridgeLog.match(/\[http\] GET \/api\/session(\?[^\s]*)?(\s|$)/g) ?? []).filter(
      (line) => !line.includes('/api/session/'),
    ).length;
    console.log(`  … GET /api/session reached the bridge: ${sessionHits}`);

    // ★ Add the bridge's project through the UI. This is the step the whole run was missing: the
    // bridge answered `/api/project` all along, but the desktop's project tree is the CLIENT's own
    // list, and a candidate only enters it through `home.project.add` — reachable from the
    // "add project" button. With the bridge on a NON-loopback address the picker is the web dialog
    // (`directoryPickerKind`), so the flow can be driven at all; on 127.0.0.1 it is a native macOS
    // dialog that CDP cannot touch.
    const projectDir = await fetch(`${bridgeUrl}/api/location`)
      .then((r) => r.json())
      .then((b) => b.directory)
      .catch(() => undefined);
    // ★ Narrow the window first. `home/route.tsx` renders the project **dropdown** only under
    // `mobile()` (max-width: 767px), and that dropdown is the ONLY place a per-server
    // "add project" control exists (`data-action="home-add-project-row"`). The wide layout has just
    // the header button, which always calls `onChooseProject(props.servers[0])` — the desktop's own
    // local server — so adding the bridge's project from it is impossible by construction.
    const resized = await cdp
      .call('Emulation.setDeviceMetricsOverride', { width: 720, height: 900, deviceScaleFactor: 0, mobile: false })
      .then(() => 'ok')
      .catch((error) => `failed: ${String(error).slice(0, 80)}`);
    console.log('  … setDeviceMetricsOverride:', resized);
    await sleep(2500);
    const viewport = await cdp.eval('return { w: window.innerWidth, mobile: matchMedia("(max-width: 767px)").matches };').catch(() => ({}));
    console.log('  … viewport:', JSON.stringify(viewport));

    const openedPicker = await cdp
      .eval(`
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const click = (el) => {
          for (const type of ['pointerdown', 'pointerup']) el.dispatchEvent(new PointerEvent(type, { bubbles: true }));
          el.click();
        };
        // The per-server control is the one that uses THAT server; the header button always uses
        // servers[0], which here is the desktop's own local server. Prefer the row, and report what
        // was found so a missing row is visible rather than silently falling back.
        const rows = [...document.querySelectorAll('[data-action="home-add-project-row"]')];
        const allActions = [...document.querySelectorAll('[data-action]')].map((x) => x.getAttribute('data-action'));
        const header = document.querySelector('[data-action="home-add-project"]');
        const button = rows[0] ?? header;
        if (!button) return { clicked: false, reason: 'no add-project control' };
        click(button);
        await sleep(2500);
        const dialog = document.querySelector('[role=dialog]');
        const inputs = [...document.querySelectorAll('input')].map((i) => i.getAttribute('placeholder') || i.type).slice(0, 8);
        return {
          clicked: true,
          which: rows[0] ? 'row' : 'header',
          rowCount: rows.length,
          actionsOnScreen: [...new Set(allActions)].slice(0, 12),
          hasHeader: !!header,
          dialog: !!dialog,
          dialogText: dialog ? (dialog.innerText || '').slice(0, 300) : '',
          inputs,
          bodyTail: (document.body.innerText || '').slice(-300),
        };
      `)
      .catch((error) => ({ error: String(error) }));
    console.log('  … add project:', JSON.stringify(openedPicker), '| dir:', projectDir);

    const listed = await waitFor(async () => {
      const body = await cdp.eval(`
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const text = (el) => (el.innerText || '').trim();
        const click = (el) => {
          for (const type of ['pointerdown', 'pointerup']) el.dispatchEvent(new PointerEvent(type, { bubbles: true }));
          el.click();
        };
        // ★ Match the BRIDGE, not "any 127.0.0.1:port". The dev desktop has its OWN local server
        // in this list, and its address is also 127.0.0.1:<port>; matching the first row of that
        // shape opened the local server instead, whose session list is empty and whose requests
        // never reach the bridge — which read as "the desktop never asked for sessions" for three
        // runs. The origin is the only reliable key.
        const WANT = ${JSON.stringify(bridgeUrl)};
        // strip the scheme without a regex literal: backslashes inside this template are consumed
        // before the page ever sees them, and a regex here fails to even parse
        const hostPort = WANT.slice(WANT.indexOf('//') + 2);
        const rows = () => [...document.querySelectorAll('[class~="group/server"]')];
        const row = rows().find((r) => text(r).includes(hostPort));
        // ★ Click the FOCUS control, not the first button in the row. The row's first button is
        // the collapse chevron (data-action=home-server-collapse); focusing the server is
        // HomeProjectNavButton's onClick, one level in. Clicking the chevron collapses a group and
        // never changes the selection — measured: the row stayed selected:false while the click
        // "succeeded".
        const focusButton = (node) => {
          const nav = node.querySelector('button:not([data-action="home-server-collapse"])');
          if (nav) return nav;
          const chevron = node.querySelector('[data-action="home-server-collapse"]');
          return chevron ? (chevron.closest('button') ?? node) : node;
        };
        if (row) {
          // Watch the row's data-selected attribute while the click lands: if it never flips, the
          // handler did not run (or the selection was rejected); if it flips and flips back, the
          // app re-selected something else right after.
          const flips = [];
          const observer = new MutationObserver(() => {
            flips.push(row.hasAttribute('data-selected') || !!row.querySelector('[data-selected]'));
          });
          observer.observe(row, { attributes: true, subtree: true, attributeFilter: ['data-selected'] });
          click(focusButton(row));
          await sleep(3000);
          observer.disconnect();
          (globalThis).__flips = flips;
          await sleep(4000);
          // a second pass: the first click can land before the tree has painted
          // The sidebar renders a session's TITLE, not its id; accept either so the retry pass
          // recognises a row that is already there under its name.
          const ident = [session.id, session.title, String(session.directory ?? '').split(/[\\/]/).filter(Boolean).pop()].filter(Boolean);
          if (!ident.some((value) => document.body.innerText.includes(value))) {
            const again = rows().find((r) => text(r).includes(hostPort));
            if (again) { click(focusButton(again)); await sleep(3000); }
          }
        }
        return document.body.innerText;
      `);
      // ★ The sidebar can label a session with its title, its id, OR the directory's basename
      // (what a session created without a name shows). Matching only the id missed rows that were
      // plainly on screen: measured `body text: "… New session / oac-desktop-5M20Dl"` with
      // `selected: true` on the bridge row and both of the first two lookups negative.
      const base = String(session.directory ?? '').split(/[\\/]/).filter(Boolean).pop() ?? '';
      const identifiable = [session.id, session.title, base].filter(
        (value) => typeof value === 'string' && value.length > 0,
      );
      return typeof body === 'string' && identifiable.some((value) => body.includes(value))
        ? body
        : undefined;
    }, 60_000);
    if (listed) ok(`the session ${session.id} is listed under the new server`);
    else {
      // Dump the sidebar so the next reader can see WHAT it did show, not just that it was empty.
      const dump = await cdp.eval('return document.body.innerText.slice(0, 400);').catch(() => '(unavailable)');
      bad(`the session never appeared in the sidebar (bridge saw: ${bridgeRoutes().join(' ; ') || 'no requests'})`);
      console.log(`    sidebar was:\n${String(dump).split('\n').map((line) => `      | ${line}`).join('\n')}`);
    }

    // The three spellings, computed once and reused inside the page script below.
    const identJson = JSON.stringify(
      [session.id, session.title, String(session.directory ?? '').split(/[\\/]/).filter(Boolean).pop()].filter(
        (value) => typeof value === 'string' && value.length > 0,
      ),
    );

    const sent = await cdp.eval(`
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const click = (el) => {
        for (const type of ['pointerdown', 'pointerup']) el.dispatchEvent(new PointerEvent(type, { bubbles: true }));
        el.click();
      };
      // back out of settings, then open the session
      const back = [...document.querySelectorAll('button')].find((b) => /^(Back to app|返回应用)$/.test((b.innerText || '').trim()));
      if (back) { click(back); await sleep(1500); }
      // Same three spellings the sidebar may label a session with (see the check above).
      const ident = ${identJson};
      const row = [...document.querySelectorAll('button,[role=button]')].find((b) =>
        ident.some((value) => (b.innerText || '').includes(value)),
      );
      if (!row) return 'session row not found';
      click(row);
      // ★ Wait for the composer instead of assuming 2.5s is enough. Opening a session re-renders
      // the whole view and the editor is mounted last; a fixed sleep reported "no composer" on a
      // session that was already open (measured with a real click on the row).
      let editor;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        editor =
          document.querySelector('[role=textbox][contenteditable=true]') ||
          [...document.querySelectorAll('[contenteditable=true]')].find((el) => el.isContentEditable);
        if (editor) break;
        await sleep(500);
      }
      if (!editor) return 'no composer after 20s';
      editor.focus();
      editor.textContent = 'hello from desktop e2e';
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'hello from desktop e2e' }));
      await sleep(600);
      for (const type of ['keydown', 'keypress', 'keyup']) {
        editor.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      }
      await sleep(1200);
      // ★ Enter alone did not submit on the build measured. The 发送 button always did.
      const button = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || '') === '发送');
      if (button && !button.disabled) click(button);
      await sleep(10_000);
      return document.body.innerText;
    `);
    // `you said` is the AGENT's own sentence; the user's row is `hello from desktop e2e`.
    /desktop-e2e-reply|you said/i.test(String(sent))
      ? ok("the agent's reply rendered in the desktop")
      : bad(`no reply on screen (${String(sent).slice(0, 140)})`);
  } finally {
    if (cdp && serverUrl) {
      const removed = await cdp.eval(REMOVE_SERVER(serverUrl)).catch(() => 'failed');
      removed === 'removed' ? ok('removed the server entry it added') : console.log(`  … server entry cleanup: ${removed}`);
    }
    cdp?.close();
    if (!process.env.KEEP) {
      killPids(/[e]lectron-vite/, 'electron-vite');
      killPids(new RegExp(`${DEV_APP.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/.*MacOS/`), 'dev Electron');
      await sleep(2000);
    } else {
      console.log('  … KEEP=1: the dev desktop was left running');
    }
    try {
      bridge?.kill('SIGKILL');
    } catch {
      /* gone */
    }
  }

  const leftovers = pidsMatching(/electron-vite|opencode-dev\/.+OpenCode Dev\.app\/Contents\/MacOS/);
  leftovers.length ? bad(`leftover dev processes: ${leftovers.join(', ')}`) : ok('no leftover dev processes');

  console.log(`\n${passed} passed, ${failed} failed`);
  console.log('Dev desktop only (userData `ai.opencode.desktop.dev`); the packaged app was never started.');
  return failed ? 1 : 0;
}

process.exit(await main());
