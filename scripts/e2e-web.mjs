/**
 * Drive the opencode web UI through the bridge: a real `opencode serve` as the page source, a real
 * bridge in front of it, and a headless browser doing what a person would do.
 *
 * ★ This is not part of `pnpm verify`: it needs an `opencode` binary that ships the web bundle and a
 * Chrome to drive. Both are checked up front and the run says which one is missing rather than
 * passing quietly — a silent pass is how a coverage gap survives for months.
 *
 * ★ Why a browser and not HTTP probes: the interesting question is whether the PAGE works, and the
 * desktop harness taught that lesson the expensive way — three of its nine failures were the harness
 * asserting on its own assumptions, and every one was only visible on screen. So every check here is
 * graded from `document.body.innerText`, never from the bridge's log.
 *
 * ★ Two CDP traps this script already hit while being written, both now avoided:
 *   ① a bare `await evaluate("const x = …")` leaks `x` into the page's global scope, and the second
 *      evaluation dies with "Identifier 'x' has already been declared" — every script is wrapped in
 *      an IIFE for that reason;
 *   ② `Runtime.evaluate` returns `undefined` on an exception, which looks identical to a legitimately
 *      absent value — the helper below reports `ERR:` instead of swallowing it.
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const ENTRY = join(ROOT, 'dist', 'index.js');
const FAKE_AGENT = join(ROOT, 'tests', 'fake-acp-agent.mjs');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const REPLY = 'webui-e2e-reply';

let passed = 0;
let failed = 0;
const ok = (message) => {
  passed += 1;
  console.log(`  ✓ ${message}`);
};
const bad = (message) => {
  failed += 1;
  console.log(`  ✗ ${message}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll `check` until it returns something truthy. */
async function waitFor(check, timeoutMs, stepMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch {
      /* keep waiting */
    }
    await sleep(stepMs);
  }
  return undefined;
}

function freePort() {
  return new Promise((done) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => done(port));
    });
  });
}

function opencodeBinary() {
  const fromEnv = process.env.OPENCODE_BIN;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  try {
    return execFileSync('which', ['opencode'], { encoding: 'utf8' }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function killPids(pattern) {
  let listing = '';
  try {
    listing = execFileSync('ps', ['-axo', 'pid,command'], { encoding: 'utf8' });
  } catch {
    return;
  }
  for (const line of listing.split('\n')) {
    if (!pattern.test(line)) continue;
    const pid = Number(line.trim().split(/\s+/)[0]);
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
  }
}

/** A CDP session over one page. Every `evaluate` is IIFE-wrapped and reports exceptions. */
async function attach(port) {
  const target = await waitFor(
    async () => {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      return list.find((entry) => entry.type === 'page');
    },
    60_000,
  );
  if (!target) return undefined;
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((open, reject) => {
    ws.onopen = open;
    ws.onerror = reject;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    const handler = pending.get(message.id);
    if (!handler) return;
    pending.delete(message.id);
    handler(message);
  };
  const send = (method, params = {}) =>
    new Promise((done) => {
      const mine = ++id;
      pending.set(mine, done);
      ws.send(JSON.stringify({ id: mine, method, params }));
    });
  const evaluate = async (body) => {
    const answer = await send('Runtime.evaluate', {
      expression: `(() => { ${body} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (answer?.result?.exceptionDetails) {
      return `ERR: ${answer.result.exceptionDetails.exception?.description ?? answer.result.exceptionDetails.text}`;
    }
    return answer?.result?.result?.value;
  };
  return { send, evaluate, close: () => ws.close() };
}

async function main() {
  console.log('opencode web UI × this bridge (headless Chrome over CDP)');

  const binary = opencodeBinary();
  if (!binary) {
    console.log('  SKIP  no `opencode` on PATH and no OPENCODE_BIN — the web UI bundle comes from it');
    return 0;
  }
  if (!existsSync(CHROME)) {
    console.log(`  SKIP  no Chrome at ${CHROME}`);
    return 0;
  }
  if (!existsSync(ENTRY)) {
    console.log(`  SKIP  ${ENTRY} is missing — run \`pnpm build\` first`);
    return 0;
  }

  const workDir = mkdtempSync(join(tmpdir(), 'oac-web-'));
  const profile = mkdtempSync(join(tmpdir(), 'oac-web-chrome-'));
  let helper;
  let bridge;
  let chrome;
  let cdp;

  try {
    // ---- the helper: a real `opencode serve`, which is where the page comes from.
    const helperPort = await freePort();
    helper = spawn(binary, ['serve', '--hostname', '127.0.0.1', '--port', String(helperPort)], {
      cwd: workDir,
      stdio: 'ignore',
      env: { ...process.env, OPENCODE_PASSWORD: 'helper-pw-not-used' },
    });
    const helperUrl = `http://127.0.0.1:${helperPort}`;
    const helperReady = await waitFor(async () => {
      const answer = await fetch(`${helperUrl}/`, {
        headers: { authorization: `Basic ${Buffer.from('opencode:helper-pw-not-used').toString('base64')}` },
      }).catch(() => undefined);
      return answer?.ok ? true : undefined;
    }, 90_000);
    if (!helperReady) throw new Error(`the helper never answered on ${helperUrl}`);
    ok('a real opencode server is serving the page');

    // ---- the bridge, in front of it.
    const bridgePort = await freePort();
    const password = 'bridge-pw-e2e';
    bridge = spawn(
      process.execPath,
      [
        ENTRY,
        '--no-tui',
        '--bridge-port', String(bridgePort),
        '--web-proxy', helperUrl,
        '--web-password', password,
        workDir,
        '--', process.execPath, FAKE_AGENT,
      ],
      {
        cwd: workDir,
        env: { ...process.env, FAKE_ACP_MODELS: '1', FAKE_ACP_REPLY: REPLY },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let bridgeLog = '';
    bridge.stdout.on('data', (chunk) => (bridgeLog += chunk));
    bridge.stderr.on('data', (chunk) => (bridgeLog += chunk));
    const bridgeUrl = await waitFor(async () => /"url":"(http:\/\/[^"]+)"/.exec(bridgeLog)?.[1], 90_000);
    if (!bridgeUrl) throw new Error(`the bridge never reported a ready line:\n${bridgeLog.slice(-800)}`);
    console.log(`  … bridge on ${bridgeUrl}, page borrowed from ${helperUrl}`);

    // ---- the two rules that matter before a browser is involved.
    const page = await fetch(`${bridgeUrl}/`);
    page.ok ? ok('the bridge serves the page from its own origin') : bad(`GET / answered ${page.status}`);
    const body = await page.text();
    body.includes('<!doctype html')
      ? ok('what it serves is a page, not a JSON envelope')
      : bad(`GET / served something else: ${body.slice(0, 80)}`);
    const ownApi = await (await fetch(`${bridgeUrl}/api/info`)).json();
    // ★ The API must be the BRIDGE's. `urls` naming the bridge's port is the cheapest proof; it is
    //   also the mistake this feature most easily makes — proxying /api/* would quietly serve
    //   opencode's own sessions instead of the agent's.
    (ownApi.urls ?? []).some((url) => String(url).includes(String(bridgePort)))
      ? ok('/api/* is answered by the bridge, not forwarded')
      : bad(`/api/info looks like the helper's: ${JSON.stringify(ownApi).slice(0, 120)}`);

    // ---- the page, in a browser.
    const debugPort = await freePort();
    chrome = spawn(
      CHROME,
      [
        '--headless=new',
        `--remote-debugging-port=${debugPort}`,
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        'about:blank',
      ],
      { stdio: 'ignore', detached: true },
    );
    chrome.unref();
    cdp = await attach(debugPort);
    if (!cdp) throw new Error('headless Chrome never exposed a page');
    ok('a headless browser is attached over CDP');

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: `${bridgeUrl}/` });
    const painted = await waitFor(async () => {
      const text = String(await cdp.evaluate('return document.body?.innerText ?? "";'));
      // The shell paints its project list; a blank page with no text means the bundle did not run.
      return /opencode|项目|Projects/i.test(text) ? text : undefined;
    }, 60_000);
    if (painted) ok('the page runs and paints its own shell');
    else {
      const text = String(await cdp.evaluate('return document.body?.innerText ?? "";'));
      bad(`the page never painted (body was ${JSON.stringify(text.slice(0, 160))})`);
    }
    const title = await cdp.evaluate('return document.title;');
    title === 'OpenCode' ? ok('the document title is the app’s') : bad(`title was ${JSON.stringify(title)}`);

    // ★ Every request the page made has to be on OUR origin. A page that reaches back to the
    //   helper would work by accident and break the moment the helper moves.
    const origins = await cdp.evaluate(`
      return JSON.stringify([...new Set(
        performance.getEntriesByType('resource')
          .map((entry) => { try { return new URL(entry.name).origin } catch { return '' } })
          .filter(Boolean)
      )]);
    `);
    const foreign = (JSON.parse(String(origins || '[]')) ?? []).filter((origin) => origin !== bridgeUrl);
    foreign.length === 0
      ? ok('every asset the page loaded came from the bridge')
      : bad(`the page loaded assets from ${JSON.stringify(foreign)}`);

    // ★ The bridge lists projects that have a session in them (that is the honest answer: an empty
    //   directory is not a conversation this server knows about). The page therefore shows nothing
    //   until one exists — measured: `主页 / 0 / 所有项目`, and no project row to click.
    const created = await fetch(`${bridgeUrl}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ directory: workDir }),
    });
    created.ok ? ok('a session exists for the page to show') : bad(`POST /api/session answered ${created.status}`);
    await cdp.send('Page.reload');
    await sleep(8000);

    // ---- a conversation, driven the way a person drives it.
    const openProject = `
      const row = [...document.querySelectorAll('a,button,[role=button]')]
        .find((el) => (el.innerText || '').includes(${JSON.stringify(workDir.split('/').pop())}));
      if (!row) return 'no project row';
      row.click();
      return 'clicked';
    `;
    const clicked = await cdp.evaluate(openProject);
    if (clicked === 'clicked') {
      ok('the project the bridge exposes is in the page');
    } else {
      // Dump what the shell DID paint: "no project row" and "a row under another name" are
      // different problems, and only the screen can tell them apart.
      const shown = String(await cdp.evaluate('return document.body?.innerText ?? "";'));
      bad(`project row: ${clicked}`);
      console.log(
        `    shell was:\n${shown
          .split('\n')
          .slice(0, 16)
          .map((line) => `      | ${line}`)
          .join('\n')}`,
      );
    }

    const composer = await waitFor(async () => {
      const count = await cdp.evaluate(
        'return document.querySelectorAll("[contenteditable=true],textarea").length;',
      );
      return count > 0 ? true : undefined;
    }, 30_000);
    composer ? ok('a session opens a composer') : bad('no composer appeared');

    if (composer) {
      // ★ The model has to be chosen on the session first, exactly as the desktop needed: with no
      //   selection the composer shows 选择模型 and the send does nothing at all, silently.
      const listed = await fetch(`${bridgeUrl}/api/session`).then((r) => r.json()).catch(() => ({}));
      const sessionId = (listed.data ?? [])[0]?.id;
      const models = await (await fetch(`${bridgeUrl}/api/model`)).json();
      const chosen = (models.data ?? []).find((model) => model.providerID && model.providerID !== 'acp');
      if (sessionId && chosen) {
        await fetch(`${bridgeUrl}/api/session/${sessionId}/model`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: { providerID: chosen.providerID, modelID: chosen.modelID ?? chosen.id },
          }),
        });
        ok(`selected ${chosen.providerID}/${chosen.modelID ?? chosen.id} on the session`);
        // The page reads the selection at load time, so it has to see it once more.
        await cdp.send('Page.reload');
        await sleep(8000);
        await cdp.evaluate(openProject);
        await waitFor(async () => {
          const count = await cdp.evaluate(
            'return document.querySelectorAll("[contenteditable=true],textarea").length;',
          );
          return count > 0 ? true : undefined;
        }, 30_000);
      } else {
        bad('the bridge offered no real model to select');
      }

      const typed = await cdp.evaluate(`
        const editor = [...document.querySelectorAll('[contenteditable=true],textarea')]
          .find((el) => el.isContentEditable || el.tagName === 'TEXTAREA');
        if (!editor) return 'no editor';
        editor.focus();
        if (editor.tagName === 'TEXTAREA') editor.value = 'hello from the web ui';
        else editor.textContent = 'hello from the web ui';
        editor.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'hello from the web ui' }));
        return 'typed';
      `);
      typed === 'typed' ? ok('the composer accepts typing') : bad(`typing: ${typed}`);

      await sleep(1200);
      await cdp.evaluate(`
        const editor = [...document.querySelectorAll('[contenteditable=true],textarea')]
          .find((el) => el.isContentEditable || el.tagName === 'TEXTAREA');
        for (const type of ['keydown', 'keypress', 'keyup']) {
          editor.dispatchEvent(new KeyboardEvent(type, {
            key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true,
          }));
        }
        return 'sent';
      `);
      const answered = await waitFor(async () => {
        const text = String(await cdp.evaluate('return document.body?.innerText ?? "";'));
        return text.includes(REPLY) ? text : undefined;
      }, 45_000);
      if (answered) {
        ok(`the agent's reply rendered in the web UI (${REPLY})`);
      } else {
        const text = String(await cdp.evaluate('return document.body?.innerText ?? "";'));
        bad(`no reply on screen (body was ${JSON.stringify(text.slice(0, 240))})`);
      }
    }
  } finally {
    cdp?.close();
    if (chrome) {
      try {
        process.kill(-chrome.pid, 'SIGKILL');
      } catch {
        try {
          chrome.kill('SIGKILL');
        } catch {
          /* gone */
        }
      }
    }
    try {
      bridge?.kill('SIGKILL');
    } catch {
      /* gone */
    }
    try {
      helper?.kill('SIGKILL');
    } catch {
      /* gone */
    }
    // The helper's children (the server it forks) outlive a plain kill.
    killPids(new RegExp(`opencode serve .*--port ${String(helper?.spawnargs?.[4] ?? 'none')}`));
    await sleep(1500);
    for (const directory of [workDir, profile]) {
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  console.log('Needs an `opencode` binary with the web bundle, and Chrome. Not part of pnpm verify.');
  return failed ? 1 : 0;
}

process.exit(await main());
