#!/usr/bin/env node
/**
 * The full matrix: every opencode v2 TUI version × every real agent, one real conversation each.
 *
 *   node scripts/e2e-matrix-real.mjs                 # whatever TUI versions and agents it finds
 *   node scripts/e2e-matrix-real.mjs --tui 2.1.4 --agents opencode,qwen
 *
 * ★ The Gemini-family agents need three environment variables, or their cells come back BLOCKED
 * for reasons that belong to the agent (see `../antigravity-cli/LOCAL-SETUP.md`):
 *
 *   NO_PROXY=127.0.0.1,localhost,::1
 *   GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:<gateway>/antigravity  # else it calls Google: 400 API_KEY_INVALID
 *   GEMINI_API_KEY=<36-char key>                                   # else 401 UNAUTHENTICATED
 *
 * ★ `agy` reads ONLY the environment — it does not read `~/.gemini/.env` the way gemini-cli does.
 * Measured: with `.env` pointing at the gateway and nothing exported, every `agy` cell came back
 * BLOCKED with `could not start the agent: Authentication required`, while `gemini` on the same
 * machine worked. Export GEMINI_API_KEY (and GOOGLE_GEMINI_BASE_URL) before running the matrix.
 *
 * ★ AND `~/.gemini/settings.json` must exist, with a `customAliases` entry whose
 * `generateContentConfig.topK` is <= 40. Without it gemini-cli sends `topK: 64` from its
 * built-in `chat-base` preset and a gateway that caps it at 40 answers
 * `body field generationConfig.topK must less than or equal 40` — every cell BLOCKED for a
 * reason that is the agent's own configuration, not the bridge's. Measured on all three
 * platforms: with the file PASS, without it BLOCKED. The alias does apply under ACP; an
 * earlier note claiming otherwise was wrong. See docs/AGENT-CAPABILITIES.md §2.6.
 *
 * The gateway PORT is per machine and the variable is therefore not defaulted here: macOS uses
 * 15721, the Linux box runs its gateway on 12300 (`codemaker-hub`). Same path suffix, different
 * port — and a `curl` against the wrong one answers 404 on `/antigravity` while `/v1/models`
 * still says 200, which reads like "this proxy has no antigravity" when it is simply the wrong
 * port.
 *
 * Two measured traps, both recorded in LOCAL-SETUP.md and both fixed here rather than left as
 * "BLOCKED" cells that read like dead agents:
 *   · gemini-cli shells out to `sysctl` at startup, so it needs `/usr/sbin` on PATH — a launcher
 *     script does not have it (see `withSystemBinaries` below);
 *   · gemini-cli sends a `generationConfig.topK` above 40 on some TUI versions and the gateway
 *     rejects it with 400. That one is the AGENT's, not the bridge's: the matrix reports it and
 *     moves on.
 *
 * ★ Why this exists next to the other two. `scripts/e2e-agent-matrix.sh` runs agents through
 * the real TUI in tmux, which cannot run on Windows and grades from a captured pane — a source
 * that mis-graded three cells (the agents' own credential errors reach the screen as
 * `Error: Internal error`, not as the text they contain). `scripts/e2e-protocol.mjs` uses the
 * fake agent, so it says nothing about a real model. This drives the same HTTP surface the TUI
 * uses, one real conversation per cell, and grades from the transcript plus the agent's own
 * error text.
 *
 * **Spends tokens** — one 3-turn conversation per cell. Deliberately not in `pnpm verify`.
 *
 * A cell is PASS, BLOCKED or FAIL:
 *   • PASS    the model answered three turns and recalled the earlier one;
 *   • BLOCKED the agent's own credentials/configuration refused it (not our bug);
 *   • FAIL    anything else — the bridge never came up, the agent exited, a turn hung.
 * The distinction matters: a BLOCKED cell is somebody's missing key, a FAIL cell is a lead.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const ENTRY = join(ROOT, 'dist', 'index.js');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- arguments
const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const onlyTui = argOf('tui')?.split(',');
const onlyAgents = argOf('agents')?.split(',');

/**
 * The TUI builds to test, discovered rather than hard-coded.
 *
 * `OPENCODE_TUI_VERSION_DIRS` wins (comma-separated `version=path`), then `/tmp/oc-<version>`
 * from the installs this repo's notes use. A hard-coded list would silently test a stale set
 * after a new version is installed.
 */
function discoverTuis() {
  const explicit = process.env['OPENCODE_TUI_VERSION_DIRS'];
  const found = [];
  if (explicit) {
    for (const entry of explicit.split(',')) {
      const [version, path] = entry.split('=');
      if (version && path) found.push({ version, bin: path });
    }
    return found;
  }
  // Windows has no `/tmp` and its npm shim is a `.cmd`, while the real program sits in the
  // package's own `bin/`. Both layouts are searched so one script serves all three platforms.
  const roots = [];
  if (process.platform === 'win32') {
    // `C:\oc-2.1.4` (the layout the Windows notes use)
    for (const drive of ['C:', 'D:']) {
      try {
        for (const name of readdirSync(`${drive}\\`)) {
          if (/^oc-2\.\d+\.\d+$/.test(name)) roots.push(join(`${drive}\\`, name));
        }
      } catch {
        /* no such drive */
      }
    }
  } else {
    try {
      for (const name of readdirSync('/tmp')) {
        if (/^oc-2\.\d+\.\d+$/.test(name)) roots.push(join('/tmp', name));
      }
    } catch {
      /* no /tmp */
    }
  }
  for (const root of roots.sort()) {
    // ★ Probe BOTH spellings, not the one this platform "should" use: `@opencode/cli` 2.0.32 and
    // 2.3.2 ship the macOS binary as `bin/opencode.exe` (a Mach-O file with a `.exe` name), so
    // guessing from `process.platform` reported those two versions as missing on Darwin and the
    // cells came back BLOCKED with `Internal error: Internal service failure` — the launcher had
    // fallen through to a path that does not exist. Order decides preference on the one platform
    // where both could exist; `existsSync` decides in practice.
    const native = process.platform === 'win32' ? 'opencode.exe' : 'opencode';
    const other = native === 'opencode' ? 'opencode.exe' : 'opencode';
    const candidates = [
      join(root, 'node_modules', '@opencode', 'cli', 'bin', native),
      join(root, 'node_modules', '@opencode', 'cli', 'bin', other),
      join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'opencode.cmd' : 'opencode'),
    ];
    const bin = candidates.find((c) => existsSync(c));
    if (bin) found.push({ version: root.split(/[\\/]/).pop().slice(3), bin });
  }
  return found;
}

/**
 * The agents to drive. `command` is an argv array: no shell, so a quoted path cannot be
 * re-split, and on Windows a `.cmd` would need `cmd.exe` — these are all invoked as programs.
 */
function discoverAgents() {
  // ★ `opencode acp` IS an agent cell, and it was wrongly excluded.
  //
  // The reasoning was "it is the TUI's own binary, so the version axis already covers it" — which
  // is wrong in the one way that matters: the agent command is built from the SAME binary the
  // version selects, so on 2.0.32 the agent under test is a 2.0.32 ACP server. Leaving it out
  // made the matrix blind to the combination the product actually ships, and it hid a real find
  // (v2.0.18's ACP cannot see a provider from `opencode.json`; v2.0.32 can). Every platform now
  // runs it, with `--version`'s binary for that row.
  //
  // On Windows the adapters live in a scratch prefix and their shims are `.cmd`, which `spawn`
  // cannot execute without a shell — so the real JS entry is invoked through `node` instead.
  // Probing for the entry rather than assuming it keeps this working on all three platforms.
  const probe = join(ROOT, '_probe', 'node_modules');
  // ★ The flags come from the caller and must survive. An earlier version of this helper
  // returned `[node, entry]` only, dropping `--acp` — so qwen started as a plain CLI, never
  // spoke ACP, and every cell timed out waiting for `initialize` (measured: a 117-119 s hang
  // per cell, which reads like a slow agent rather than a missing argument).
  /** An agent installed by its own installer, under a path a launcher script does not search. */
  const installedBinary = (path, ...flags) => (existsSync(path) ? [path, ...flags] : undefined);

  const adapter = (pkg, dir, ...flags) => {
    const entry = join(probe, ...pkg.split('/'), dir);
    return existsSync(entry) ? [process.execPath, entry, ...flags] : undefined;
  };
  const candidates = [
    {
      id: 'claude',
      command:
        adapter('@agentclientprotocol/claude-agent-acp', 'dist/index.js') ?? [
          'npx',
          '-y',
          '@agentclientprotocol/claude-agent-acp',
        ],
    },
    {
      id: 'codex',
      command:
        adapter('@agentclientprotocol/codex-acp', 'dist/index.js') ?? ['npx', '-y', '@agentclientprotocol/codex-acp'],
    },
    {
      id: 'qwen',
      command: adapter('@qwen-code/qwen-code', 'cli-entry.js', '--acp') ?? ['qwen', '--acp'],
    },
    {
      id: 'dsh',
      // `dsh` is distributed as an npm package whose shim is a `.cmd` on Windows, which `spawn`
      // cannot execute without a shell; prefer the real entry point when the package sits in the
      // scratch prefix, and fall back to the command for a global install.
      command:
        adapter('@deepseek-ai/dsh', 'lib/bin.js', '--profile', 'acp') ?? ['dsh', '--profile', 'acp'],
    },
    {
      // Antigravity. Needs three env vars and a 36-character key to point it at a custom
      // endpoint (see `antigravity-cli/LOCAL-SETUP.md`, which is where this was worked out):
      // without `GOOGLE_GEMINI_BASE_URL` it calls Google directly and answers 400
      // API_KEY_INVALID, and a key that is not 36 characters gets 401 UNAUTHENTICATED from the
      // gateway. `agy acp` takes no --model/--effort; both are negotiated over ACP.
      id: 'agy',
      // The installer puts the binary under `%LOCALAPPDATA%\agy\bin` and says so ("not present in
      // your active Environment PATH"), so a Windows run without that directory reports the agent
      // as missing even though it is installed. Prefer the absolute path when it exists there.
      command: installedBinary(
        process.platform === 'win32'
          ? join(process.env.LOCALAPPDATA ?? '', 'agy', 'bin', 'agy.exe')
          : join(process.env.HOME ?? '', '.local', 'bin', 'agy'),
        'acp',
      ) ?? ['agy', 'acp'],
    },
    {
      // gemini-cli's own ACP server. Same three variables as `agy`, different dialect
      // (google.genai rather than `agy`'s adapter).
      id: 'gemini',
      // gemini-cli's own ACP server. Same three variables as `agy`, different dialect
      // (google.genai rather than `agy`'s adapter). npm installs it as a `.cmd` shim on Windows,
      // which `spawn` cannot execute without a shell, so the real entry point is preferred.
      command:
        adapter('@google/gemini-cli', 'bundle/gemini.js', '--acp') ??
        installedBinary(
          process.platform === 'win32'
            ? join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@google', 'gemini-cli', 'bundle', 'gemini.js')
            : join(process.env.HOME ?? '', '.nvm', 'versions', 'node', process.versions.node, 'lib', 'node_modules', '@google', 'gemini-cli', 'bundle', 'gemini.js'),
          '--acp',
        ) ??
        ['gemini', '--acp'],
    },
    {
      // GitHub Copilot CLI. Its BYOK path is the legacy `COPILOT_PROVIDER_*` environment (see
      // `copilot help providers-env`), NOT `~/.copilot/providers.json`: on an account without
      // individual-model access the file route answers `only Copilot Fusion mode is available on
      // your plan`, while the variables work and need no GitHub login. The four variables are read
      // from the environment the matrix is launched with, so no credential lives in this script.
      id: 'copilot',
      command: ['copilot', '--acp'],
    },
    {
      // Qoder CLI, CN build. The international `qodercli` and this one are separate products with
      // separate accounts: a CN token is rejected by the international build and vice versa, and the
      // CN config lives under `~/.qoder-cn/`. Auth is one variable, no browser; a BYOK model has to be
      // declared at the TOP LEVEL of `~/.qoder-cn/settings.json` (`providers` + `model`) — the
      // `modelConfigs` block the binary's schema advertises does nothing on its own (see
      // docs/AGENT-SETUP §9 in the owner's notes).
      id: 'qoder',
      command: ['qoderclicn', '--acp'],
    },
  ];
  return candidates;
}

/**
 * The directories a login shell has that a launcher script usually does not.
 *
 * `gemini-cli` calls `sysctl` (macOS) and looks for `ss`/`netstat` (Linux) from the sbin
 * directories; a process started from a shell script or a CI step sees a PATH without them, so
 * the agent dies with ENOENT at startup and the failure surfaces as "agent exited".
 */
function withSystemBinaries(path) {
  // ★ The separator is the PLATFORM's, not a constant `:`. Splitting a Windows PATH on `:` turns
  // `C:\Program Files\nodejs;C:\Users\me\AppData\Roaming\npm` into fragments and rejoining
  // with `:` produces one unusable path — so the bridge could not find ANY npm-installed agent
  // (`copilot`, `pi-acp`) and both reported `agent exited: ACP connection closed` within a second,
  // while `opencode acp` passed because the matrix gives it an absolute path. Measured on the
  // Windows VM: the same `copilot --acp` starts fine with the inherited PATH untouched.
  const sep = process.platform === 'win32' ? ';' : ':';
  // POSIX-only directories: a Windows PATH has no `/usr/sbin`.
  const extra = process.platform === 'win32' ? [] : ['/usr/sbin', '/sbin', '/usr/local/sbin'];
  const have = new Set((path ?? '').split(sep).filter(Boolean));
  return [...have, ...extra.filter((dir) => !have.has(dir))].join(sep);
}

// ---------------------------------------------------------------- one cell
async function runCell(tui, agent) {
  const work = mkdtempSync(join(tmpdir(), 'oac-mx-'));
  // A FIXED port is a trap: a bridge left over from an earlier cell keeps answering on it, and
  // the new cell then waits for a ready line that belongs to software it did not start. The
  // bridge picks a free port itself when this is omitted.
  const port = String(5800 + Math.floor(Math.random() * 180));
  const bridge = spawn(
    process.execPath,
    [ENTRY, '--no-tui', '--bridge-port', port, work, '--', ...agent.command],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        // ★ Inherit the login shell's PATH shape. A process launched from a script does NOT get
        // `/usr/sbin`, and gemini-cli shells out to `sysctl` from there at startup
        // (`systemArchitectureSync`) — without it the agent dies with ENOENT before answering
        // `initialize`, and the matrix reports a BLOCKED cell that looks like a dead agent.
        // Measured on macOS: `gemini --acp` works in a login shell and exits instantly here.
        PATH: withSystemBinaries(process.env.PATH),
        OPENCODE_ACP_CLIENT_SESSION_MAP: join(work, 'sessions.json'),
        // OPENCODE_BIN is the TUI binary, NOT the agent's. Setting it here made the bridge
        // resolve a version and probe it while the agent was starting, which is work this cell
        // does not need; the TUI is not launched at all in --no-tui mode.
        OPENCODE_DISABLE_AUTOUPDATE: "1",
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let log = '';
  bridge.on('error', (err) => {
    log += `\n[spawn error] ${err.message}\n`;
  });
  bridge.stdout.on('data', (d) => {
    log += String(d);
  });
  bridge.stderr.on('data', (d) => {
    log += String(d);
  });

  const api = async (path, init) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, init);
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    return { status: response.status, body, text };
  };

  const rows = async (session) => {
    const { body } = await api(`/api/session/${session}/message`);
    return (body?.data ?? [])
      .filter((row) => row.type === 'assistant')
      .map((row) => ({
        id: row.id,
        text: (row.content ?? []).map((part) => part.text ?? '').join(''),
        // ★ Tools count as output. Some agents (measured: gemini --acp) begin a turn by
        // calling an internal bookkeeping tool (`update_tactical_intent`) and, some of the
        // time, end the turn there without ever emitting text. The turn DID run and the tool
        // DID execute; grading that as "produced no text" reported a working agent as flaky,
        // which sent us chasing a gateway that was never at fault.
        tools: (row.content ?? []).filter((part) => part.type === 'tool').length,
        model: row.model,
        error: row.error?.message,
        done: Boolean(row.time?.completed),
      }))
      .reverse();
  };

  const turn = async (session, id, text, timeoutMs = 180_000) => {
    // Track by ROW ID, not by count. Counting assumed every turn appends a new assistant row;
    // when the bridge instead reuses or completes an existing one, the count never grows and
    // the wait times out — or, worse, returns whichever row happened to be there.
    const seen = new Set((await rows(session)).filter((r) => r.done).map((r) => r.id));
    await api(`/api/session/${session}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, text }),
    });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const list = await rows(session);
      // ★ `rows()` reverses (the API is newest-first), so element 0 is the NEWEST row. Taking
      // the last element returned the OLDEST completed row — turn 1's answer read as turn 3's,
      // which graded a correct memory as a failure.
      const fresh = list.find((row) => row.done && !seen.has(row.id));
      if (fresh) return fresh;
      await sleep(400);
    }
    return undefined;
  };

  try {
    let url;
    for (let i = 0; i < 160 && !url; i += 1) {
      if (/"url":"([^"]+)"/.test(log)) url = true;
      else await sleep(250);
    }
    if (!url) {
      // A command the machine does not have is not a defect in the software under test: the
      // bridge says so and nothing hangs. Distinguish it from a real failure.
      if (/agent command not found|not found/i.test(log) && /\[bridge\]/.test(log)) {
        return { verdict: 'BLOCKED', reason: 'agent command not available on this machine', log };
      }
      const tail = log.split('\n').filter((l) => /acp|error|Error|exit/i.test(l)).slice(-4).join(' | ');
    return { verdict: 'FAIL', reason: `bridge never became ready${tail ? `: ${tail}` : ''}`, log };
    }

    const created = await api('/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const session = created.body?.data?.id;
    if (!session) return { verdict: 'FAIL', reason: `no session (HTTP ${created.status})`, log };

    // ★ Turn 1 must be impossible to misread as an instruction to the AGENT about itself.
    // "In one short sentence: what is a protocol?" was read as a session-title request about a
    // quarter of the time: gemini-cli called its `update_topic` tool with the question as the
    // topic, produced no text, and the cell graded FAIL — which looked like the agent being
    // flaky when it was the prompt being ambiguous. A plain instruction to echo a token has no
    // such reading and still proves the round trip carries text.
    const t1 = await turn(session, 'mx_1', 'Reply with exactly this word and nothing else: PROTOCOL');
    if (!t1) return { verdict: 'FAIL', reason: 'turn 1 never finished', log };
    if (t1.error) return { verdict: 'BLOCKED', reason: t1.error, log };
    if (t1.text.trim() === '' && !t1.tools)
      return { verdict: 'FAIL', reason: 'turn 1 produced no text and no tool call', log };

    const t2 = await turn(session, 'mx_2', 'Now answer with exactly one word: REPEAT. Nothing else.');
    if (!t2) return { verdict: 'FAIL', reason: 'turn 2 never finished', log };
    if (t2.error) return { verdict: 'BLOCKED', reason: t2.error, log };
    if (t2.text.trim() === '' && t2.tools)
      // A bookkeeping-tool-only turn is legal but proves nothing about recall; retry once.
      return { verdict: 'UNKNOWN', reason: 'turn 2 produced only a tool call, nothing to compare', log };

    const t3 = await turn(
      session,
      'mx_3',
      'Which word did I ask you to say in my previous message? Reply with just that word.',
    );
    if (!t3) return { verdict: 'FAIL', reason: 'turn 3 never finished', log };
    if (t3.error) return { verdict: 'BLOCKED', reason: t3.error, log };
    // ★ The word must APPEAR, not be the whole answer. "Reply with just that word" is a request,
    // and a real model routinely wraps it — codex prefixes a metadata warning, others add a
    // sentence. Requiring the reply to equal the word graded a correct answer as a failure,
    // which is the same mistake as testing a UI for an exact string: the assertion has to match
    // what is being proven ("the history survived"), not a formatting habit.
    // ★ Either word counts. Turn 1 asks for PROTOCOL and turn 2 for REPEAT, so a model that
    // keeps answering PROTOCOL in turn 2 ("answer with exactly one word" reads as "keep it short",
    // not "change the word") is reasoning correctly; grading only REPEAT called dsh's right answer
    // a memory failure. What the turn proves is that SOME earlier word came back.
    const recalled = /\b(repeat|protocol)\b/i.test(t3.text);
    if (!recalled && t3.text.trim() === '' && t3.tools) {
      // Same bookkeeping-tool case as turn 2: the turn ran, nothing was said. Not a recall
      // failure — say so, rather than reporting a memory bug the agent never had.
      return { verdict: 'UNKNOWN', reason: 'turn 3 produced only a tool call, nothing to compare', log };
    }
    if (!recalled && !/\b(repeat|protocol)\b/i.test(t2.text)) {
      return { verdict: 'FAIL', reason: `turn 3 did not recall: ${JSON.stringify(t3.text.slice(0, 80))}`, log };
    }
    if (!recalled) {
      // The answer for turn 2 did not itself contain the word, so "turn 3 mentions it" is not
      // proof of memory. Say so rather than passing on a coincidence.
      return { verdict: 'UNKNOWN', reason: `turn 3 gave ${JSON.stringify(t3.text.slice(0, 60))}`, log };
    }

    const all = await rows(session);
    const models = [...new Set(all.map((r) => (r.model ? `${r.model.providerID}/${r.model.id}` : '(none)')))];
    return {
      verdict: 'PASS',
      reason: `3 turns, history intact, model ${models.join('|')}`,
      model: models[0],
      log,
    };
  } finally {
    bridge.kill();
    try {
      rmSync(work, { recursive: true, force: true });
    } catch {
      /* the OS collects temp */
    }
  }
}

// ---------------------------------------------------------------- the run
const tuis = discoverTuis().filter((t) => !onlyTui || onlyTui.includes(t.version));
const agents = discoverAgents().filter((a) => !onlyAgents || onlyAgents.includes(a.id));

if (tuis.length === 0) {
  console.error('no TUI builds found. Install one with:');
  console.error('  mkdir -p /tmp/oc-2.1.4 && cd /tmp/oc-2.1.4 && npm init -y && npm i @opencode/cli@2.1.4');
  console.error('or set OPENCODE_TUI_VERSION_DIRS="2.1.4=/path/to/opencode,..."');
  process.exit(2);
}

console.log(`▸ TUI versions: ${tuis.map((t) => t.version).join(', ')}`);
console.log(`▸ agents:       ${agents.map((a) => a.id).join(', ')}`);
console.log(`▸ cells:        ${tuis.length * agents.length}\n`);

const results = [];
for (const tui of tuis) {
  // `opencode acp` is built PER ROW: the agent command is this row's own TUI binary, which is
  // the whole point of testing it here rather than once. `command` is resolved lazily so a
  // version that cannot serve ACP reports as its own cell instead of poisoning the list.
  const agentsForRow = [
    { id: 'opencode', command: [tui.bin, 'acp'] },
    // pi + pi-acp: spawns `pi --mode rpc` and bridges it to ACP. Two settings in
    // `~/.pi/agent/settings.json` decide whether a cell means anything — `quietStartup: true`
    // (otherwise the first turn's text is pi's startup banner, not the model's answer) and
    // `defaultProvider`/`defaultModel` as separate fields (see docs/AGENT-CAPABILITIES.md §2.7).
    { id: 'pi', command: ['pi-acp'] },
    ...agents,
  ];
  for (const agent of agentsForRow) {
    const label = `${tui.version} × ${agent.id}`;
    process.stdout.write(`▸ ${label} … `);
    if (process.env['MATRIX_DEBUG']) console.log('\n  argv:', JSON.stringify(agent.command));
    const started = Date.now();
    let result;
    try {
      result = await runCell(tui, agent);
    } catch (err) {
      result = { verdict: 'FAIL', reason: err instanceof Error ? err.message : String(err), log: '' };
    }
    const seconds = Math.round((Date.now() - started) / 1000);
    if (result.verdict !== 'PASS' && result.log) {
      const { writeFileSync, mkdirSync } = await import('node:fs');
      mkdirSync(join(ROOT, '.artifacts', 'matrix-real'), { recursive: true });
      writeFileSync(join(ROOT, '.artifacts', 'matrix-real', `fail-${tui.version}-${agent.id}.log`), result.log);
    }
    const mark = result.verdict === 'PASS' ? '✓' : result.verdict === 'BLOCKED' ? '·' : '✗';
    console.log(`${mark} ${result.verdict} (${seconds}s) — ${String(result.reason).slice(0, 100)}`);
    results.push({ label, ...result });
    await sleep(1500);
  }
}

console.log('\n── matrix');
const width = Math.max(...results.map((r) => r.label.length));
for (const r of results) {
  const mark = r.verdict === 'PASS' ? '✓' : r.verdict === 'BLOCKED' ? '·' : '✗';
  console.log(`  ${mark} ${r.label.padEnd(width)}  ${r.verdict.padEnd(8)} ${String(r.reason).slice(0, 90)}`);
}
const count = (v) => results.filter((r) => r.verdict === v).length;
console.log(`\n── ${count('PASS')} passed, ${count('BLOCKED')} blocked by the agents themselves, ${count('FAIL')} failed`);
process.exit(count('FAIL') === 0 ? 0 : 1);
