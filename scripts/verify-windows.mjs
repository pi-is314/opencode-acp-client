#!/usr/bin/env node
/**
 * The gate, on Windows — the same steps as `scripts/verify.sh`, minus the ones that need tmux.
 *
 *   pnpm verify:win
 *
 * Why a second door to the same room. `verify.sh` is bash and drives eleven real-TUI modes
 * through tmux; Windows has neither, so the gate simply never ran there, and "works on macOS and
 * Linux" was all the evidence the project had. That gap is real: a bug that only shows on
 * Windows (`spawn` refusing a `.cmd` shim, `detached: true` silently dropping pipe output) was
 * found by hand, not by the gate.
 *
 * What runs here, in the same order and with the same verdicts as `verify.sh`:
 *
 *   typecheck · unit tests · build · doc links · published-spec conformance ·
 *   e2e smoke (20 scenarios) · e2e entry (single command, exit code, no strays) ·
 *   e2e protocol (the only end-to-end check with no tmux) · e2e todo (a real TUI through node-pty)
 *
 * What cannot: the eleven `MODE=` real-TUI modes and the epilogue, both of which are tmux
 * sessions with captured panes. This script says so out loud rather than quietly proving less —
 * the same rule `VERIFY_SKIP_TUI=1` follows on the bash side.
 *
 * Environment:
 *   OPENCODE_BIN=<path>    opencode binary the e2e steps drive (passed through)
 *   OPENCODE_SPEC=<path>   use this spec file instead of .cache/openapi.json
 *   OPENCODE_SPEC_MAX_AGE=<s>  how old a cached spec may be before it is re-fetched
 *   PYTHON=<cmd>           python (the spec check needs jsonschema)
 *   VERIFY_SKIP_TODO=1     skip the node-pty todo mode (it needs a console)
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = process.env.OPENCODE_SPEC ?? join(REPO, '.cache', 'openapi.json');
const SPEC_URL = 'https://opencode.ai/v2/openapi.json';
const PY = process.env.PYTHON ?? 'python';

let failed = 0;

function step(title) {
  process.stdout.write(`\n▸ ${title}\n`);
}

function fail(message) {
  process.stdout.write(`\n✗ ${message}\n`);
  failed += 1;
}

/**
 * Run one command, streaming its output, and return whether it succeeded.
 *
 * `shell: true` only for the package-manager shims: pnpm and npx are `.cmd` files on Windows and
 * cannot be spawned directly (the same reason `src/acp/client.ts` routes `.cmd` through cmd.exe).
 * A command whose arguments carry quotes would be re-parsed by cmd, so every npm tool here is
 * invoked through `node` with an explicit script path wherever one exists.
 */
function run(command, args, { optional = false } = {}) {
  process.stdout.write(`  $ ${command} ${args.join(' ')}\n`);
  const result = spawnSync(command, args, { cwd: REPO, stdio: 'inherit', shell: false, env: process.env });
  if (result.error) {
    if (!optional) fail(`${command} could not run: ${result.error.message}`);
    return false;
  }
  return result.status === 0;
}

/** A step that must pass. */
function must(title, command, args) {
  step(title);
  if (!run(command, args)) fail(title.split(' (')[0].toLowerCase());
}

/** Refresh a stale spec, then require the conformance check to pass. */
function specConformance() {
  step('published-spec conformance');
  const maxAge = Number(process.env.OPENCODE_SPEC_MAX_AGE ?? 86_400);
  const stale =
    !existsSync(SPEC) || (maxAge === 0 ? true : Date.now() - statSync(SPEC).mtimeMs > maxAge * 1000);
  if (stale) {
    mkdirSync(dirname(SPEC), { recursive: true });
    process.stdout.write(`  fetching ${SPEC_URL}\n`);
    // A stale contract beats an empty one, so a failed fetch keeps the cache and says so.
    const fetched = run('node', [
      '-e',
      [
        'const {writeFileSync}=require("node:fs");',
        `fetch(${JSON.stringify(SPEC_URL)}).then(async (r) => {`,
        '  if (!r.ok) throw new Error(`HTTP ${r.status}`);',
        '  const text = await r.text();',
        '  JSON.parse(text);',
        `  writeFileSync(${JSON.stringify(SPEC + '.tmp')}, text);`,
        `  require("node:fs").renameSync(${JSON.stringify(SPEC + '.tmp')}, ${JSON.stringify(SPEC)});`,
        '}).catch((e) => { console.error(e.message); process.exit(1); });',
      ].join('\n'),
    ]);
    if (!fetched) {
      process.stdout.write('  ! could not refresh the spec; using the cached copy — it may predate this release\n');
    }
  }
  if (!run(PY, ['-c', 'import jsonschema'], { optional: true })) {
    fail('the spec check needs python + jsonschema (pip install jsonschema), or set PYTHON');
    return;
  }
  if (!run(PY, [join('scripts', 'check-openapi.py'), '--spec', SPEC])) fail('spec conformance');
}

process.stdout.write(`▸ Windows gate (no tmux: the real-TUI modes are not part of this run)\n`);

must('typecheck', 'node', [join('node_modules', 'typescript', 'bin', 'tsc'), '--noEmit']);
must('unit tests', 'node', [join('node_modules', 'vitest', 'vitest.mjs'), 'run']);
must('build (the e2e scripts drive dist/)', 'node', [join('node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json']);

step('docs links (an unmirrored bilingual pair is a broken link)');
if (!run(PY, [join('scripts', 'check-links.py')])) fail('docs links');

specConformance();

must('e2e: smoke (20 scenarios, fake agent, real HTTP)', 'node', [join('scripts', 'e2e-smoke.mjs')]);
must('e2e: entry (single command, exit code, no strays)', 'node', [join('scripts', 'e2e-entry.mjs')]);
must('e2e: protocol (ready line → session → turn → catalog → model → interrupt)', 'node', [
  join('scripts', 'e2e-protocol.mjs'),
]);

if (process.env.VERIFY_SKIP_TODO === '1') {
  process.stdout.write('\n! e2e: todo SKIPPED (VERIFY_SKIP_TODO=1)\n');
} else {
  must('e2e: todo (a real TUI through node-pty; asserts the v2.1 todo sidebar)', 'node', [
    join('scripts', 'e2e-todo-windows.mjs'),
  ]);
}

process.stdout.write(
  '\n! not run here: the eleven `MODE=` real-TUI modes and the exit epilogue —\n' +
    '! both are tmux sessions with captured panes, and Windows has no tmux.\n' +
    '! The macOS/Linux gate covers them; this run proves the rest on Windows.\n',
);

if (failed > 0) {
  process.stdout.write(`\n✗ windows gate failed: ${failed} step(s)\n`);
  process.exit(1);
}
process.stdout.write('\n✓ windows gate passed\n');
