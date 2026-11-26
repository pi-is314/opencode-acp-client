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
 * ★ STATUS (measured 2026-11-26): the first eight checks pass — the bridge serves, the dev
 * desktop opens over CDP, the bridge can be added as a server through its real UI, and the
 * sidebar lists it. The LAST TWO FAIL: a desktop that was launched moments ago asks for
 * `/api/project`, `/api/location` and `/api/vcs`, draws the server row, and then never sends
 * `GET /api/session` at all, so no conversation is listed. A desktop that had been running for a
 * while DID send it and listed the session — same bridge, same click. Longer settles (15s and
 * more) do not change it, dead server entries are ruled out, and `/api/project` no longer
 * answers `[]` (that was a real bug, fixed). So this is an opencode dev-build startup behaviour,
 * not a bridge defect; the script is kept as the harness for whenever it is resolved, and it is
 * deliberately NOT part of `pnpm verify`.
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
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
      [ENTRY, '--no-tui', '--bridge-port', String(port), workDir, '--', process.execPath, FAKE_AGENT],
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
    const sidebarRow = /127\.0\.0\.1:\d+/;
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

    const listed = await waitFor(async () => {
      const body = await cdp.eval(`
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const text = (el) => (el.innerText || '').trim();
        const click = (el) => {
          for (const type of ['pointerdown', 'pointerup']) el.dispatchEvent(new PointerEvent(type, { bubbles: true }));
          el.click();
        };
        // the server group's row: its class is group/server (with a slash), so match by attribute
        const row = [...document.querySelectorAll('[class~="group/server"]')].find((r) => /127\.0\.0\.1:\d+/.test(text(r)));
        if (row) {
          click(row.querySelector('button') || row);
          await sleep(4000);
          // a second pass: the first click can land before the tree has painted
          if (!document.body.innerText.includes(${JSON.stringify('session.id')})) {
            const again = [...document.querySelectorAll('[class~="group/server"]')].find((r) => /127\.0\.0\.1:\d+/.test(text(r)));
            if (again) { click(again.querySelector('button') || again); await sleep(3000); }
          }
        }
        return document.body.innerText;
      `);
      return typeof body === 'string' && body.includes(session.id) ? body : undefined;
    }, 60_000);
    if (listed) ok(`the session ${session.id} is listed under the new server`);
    else {
      // Dump the sidebar so the next reader can see WHAT it did show, not just that it was empty.
      const dump = await cdp.eval('return document.body.innerText.slice(0, 400);').catch(() => '(unavailable)');
      bad(`the session never appeared in the sidebar (bridge saw: ${bridgeRoutes().join(' ; ') || 'no requests'})`);
      console.log(`    sidebar was:\n${String(dump).split('\n').map((line) => `      | ${line}`).join('\n')}`);
    }

    const sent = await cdp.eval(`
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const click = (el) => {
        for (const type of ['pointerdown', 'pointerup']) el.dispatchEvent(new PointerEvent(type, { bubbles: true }));
        el.click();
      };
      // back out of settings, then open the session
      const back = [...document.querySelectorAll('button')].find((b) => /^(Back to app|返回应用)$/.test((b.innerText || '').trim()));
      if (back) { click(back); await sleep(1500); }
      const row = [...document.querySelectorAll('button,[role=button]')].find((b) => (b.innerText || '').includes(${JSON.stringify(session.id)}));
      if (!row) return 'session row not found';
      click(row);
      await sleep(2500);
      // the composer IS contenteditable=true (also role=textbox) — the modern shell
      const editor = document.querySelector('[role=textbox][contenteditable=true]') || document.querySelector('[contenteditable=true]');
      if (!editor) return 'no composer';
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
