#!/usr/bin/env node
/**
 * `MODE=todo` for Windows — v2.1's todo sidebar, asserted on the captured screen.
 *
 * `scripts/e2e-real-tui.sh` covers this with tmux, which Windows does not have, so the only
 * platform whose rendering was never actually checked was the one where the terminal layer
 * differs most. This does the same four assertions with `node-pty` standing in for tmux:
 * spawn the TUI on a real pseudo-terminal, type the prompt, read the pane.
 *
 * It also SKIPS on a v2.0 binary exactly like the bash mode does, and for the same reason:
 * the todo surface arrived in v2.1, and failing a supported release would be wrong.
 *
 *   node scripts/e2e-todo-windows.mjs
 *   OPENCODE_BIN='C:\occ21\node_modules\.bin\opencode.cmd' node scripts/e2e-todo-windows.mjs
 *
 * Requirements (Windows only): `node-pty` in node_modules — `pnpm add -D node-pty`, then
 * `pnpm rebuild node-pty`. `npm install` fails on it in npm 12 (ERR: Cannot read properties
 * of null), which is why the hint says pnpm.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const ENTRY = join(ROOT, 'dist', 'index.js');
const AGENT = join(ROOT, 'tests', 'fake-acp-agent.mjs');
/** Where the pane text lands, so a failing run leaves the evidence behind. */
const ARTIFACTS = join(ROOT, '.artifacts');

let passed = 0;
let failed = 0;
const ok = (what) => {
  passed += 1;
  console.log(`  ✓ ${what}`);
};
const bad = (what) => {
  failed += 1;
  console.error(`  ✗ ${what}`);
};
const note = (what) => console.log(`  ! ${what}`);

if (process.platform !== 'win32') {
  // Not a failure: this is the complement to the bash mode, and that one owns every other
  // platform. Saying so beats a silent pass that proves nothing.
  console.log('  ! this check is for Windows (MODE=todo in scripts/e2e-real-tui.sh covers the rest)');
  process.exit(0);
}

// ★ `createRequire`, not `await import()`. node-pty is a native CJS addon, and under pnpm a
// dependency that is not the project's own is reachable through a symlinked store path that
// `require` follows and the ESM resolver does not: measured on the Windows VM, `require('node-pty')`
// loaded fine while `import('node-pty')` answered `Cannot find package 'node-pty'`, which this
// script reported as "not installed" and failed the gate's last step.
const pty = createRequire(import.meta.url)('node-pty');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const work = mkdtempSync(join(tmpdir(), 'oac-todo-win-'));
const opencode = process.env['OPENCODE_BIN'] ?? 'opencode';

/** Strip the escapes a terminal screen arrives wrapped in. */
const plain = (raw) =>
  raw
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '') // OSC (titles, kitty, notifications)
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '') // CSI (cursor, colour, modes)
    .replace(/\x1b[()][A-Za-z0-9]/g, ''); // charset selection

const bridge = spawn(
  process.execPath,
  [ENTRY, '--no-tui', '--bridge-port', '5729', work, '--', process.execPath, AGENT],
  {
    cwd: ROOT,
    env: {
      ...process.env,
      OPENCODE_ACP_CLIENT_SESSION_MAP: join(work, 'sessions.json'),
      // The same fixture the bash mode uses: a completed `todowrite` whose input carries the
      // list. The agent's reply differs from the prompt so one echo cannot satisfy both.
      FAKE_ACP_SCENARIO: 'rich-turn',
      FAKE_ACP_TODO: '1',
      FAKE_ACP_MODELS: '1',
      FAKE_ACP_REPLY: 'TODO_OK',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);

let bridgeLog = '';
// A spawn that fails reports it as an EVENT, not by throwing: without this listener the
// failure surfaced only as "no ready line" with the real reason discarded.
bridge.on('error', (err) => {
  bridgeLog += `\n[spawn error] ${err.code ?? ''}: ${err.message}\n`;
});
bridge.stdout.on('data', (chunk) => {
  bridgeLog += String(chunk);
});
bridge.stderr.on('data', (chunk) => {
  bridgeLog += String(chunk);
});

let term;
try {
  console.log(`▸ tui: ${opencode}`);
  let url;
  for (let attempt = 0; attempt < 120 && !url; attempt += 1) {
    const match = /"url":"([^"]+)"/.exec(bridgeLog);
    if (match) url = match[1];
    else await sleep(200);
  }
  if (!url) {
    bad(`the bridge printed no ready line (exited: ${bridge.exitCode ?? 'still running'})`);
    console.error(bridgeLog.slice(-600));
    process.exit(1);
  }
  ok('adapter is up');

  // ★ A `.cmd` cannot be spawned with pipes on Windows (EINVAL) — the same shape as the bug
  // `launchSpec()` fixes in src/acp/client.ts. `cmd.exe` is how the bash script's tmux call
  // reaches it too.
  // ★ `@opencode/cli` ships a real `opencode.exe`; the `.cmd` next to it is npm's shim. Prefer
  // the exe: a pseudo-terminal spawns it directly, with no `cmd /s /c` quoting to get wrong
  // (measured: every quoted variant was handed to cmd as one literal command name). Fall
  // back to the command as given when no exe is found.
  const exe = /\.cmd$/i.test(opencode)
    ? join(opencode.replace(/[\\/][^\\/]+$/, ''), '..', 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe')
    : undefined;
  const target = exe && existsSync(exe) ? exe : opencode;
  const args = ['--server', url];
  if (target !== opencode) note(`using ${target} (the package's own exe, not npm's .cmd shim)`);
  term = pty.spawn(target, args, {
    name: 'xterm-256color',
    cols: 160,
    rows: 42,
    cwd: work,
    env: { ...process.env, OPENCODE_DISABLE_AUTOUPDATE: '1' },
  });

  let raw = '';
  term.onData((data) => {
    raw += data;
  });

  let ready = false;
  for (let attempt = 0; attempt < 60 && !ready; attempt += 1) {
    await sleep(500);
    ready = /Ask anything|Fake-Acp/.test(plain(raw));
  }
  if (ready) ok('the TUI became ready for input');
  else bad('the TUI never became ready for input');

  term.write('go');
  await sleep(400);
  term.write('\r');

  let finished = false;
  for (let attempt = 0; attempt < 60 && !finished; attempt += 1) {
    await sleep(500);
    finished = plain(raw).includes('TODO_OK');
  }
  if (finished) ok('the turn finished');
  else bad('the turn never finished');

  // The sidebar is drawn from the LAST full repaint, so give the client a moment to settle
  // before reading the pane — the same `sleep 2` the bash mode does.
  await sleep(3000);
  const screen = plain(raw);
  mkdirSync(ARTIFACTS, { recursive: true });
  const saved = join(ARTIFACTS, 'tui-windows-todo.txt');
  writeFileSync(saved, screen, 'utf8');
  note(`pane saved to ${saved.replace(ROOT, '.')}`);

  screen.includes('Todo') ? ok('the sidebar shows the todo heading') : bad('the sidebar has no Todo section');
  screen.includes('write the parser') ? ok('the completed todo is rendered') : bad('the completed todo is missing');
  screen.includes('run the tests') ? ok('the in-progress todo is rendered') : bad('the in-progress todo is missing');
  screen.includes('ship it') ? ok('the pending todo is rendered') : bad('the pending todo is missing');
} finally {
  term?.kill();
  bridge.kill();
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {
    /* Windows may still hold it; the OS collects temp */
  }
}

console.log(`\n── ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
