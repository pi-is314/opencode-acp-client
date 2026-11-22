#!/usr/bin/env node
/**
 * A real conversation through the bridge, against a REAL agent and a REAL model.
 *
 * This is the check the other scripts cannot make: `e2e-protocol.mjs` and the unit suite use
 * the fake agent, which proves the protocol plumbing but says nothing about whether a real
 * model answers a real turn. `e2e-real-agent.sh` sends no prompt by default (it must not spend
 * tokens), so nothing in the repo exercised an actual conversation end to end.
 *
 * What it drives, through the same HTTP surface the TUI uses:
 *
 *   1. a first turn, and the model's own words must come back;
 *   2. a SECOND turn in the same session — the context has to survive, which is the part a
 *      single-turn smoke cannot show (history is a separate code path: the transcript, the
 *      per-session catalog, the agent's own conversation state);
 *   3. a third turn that depends on the first two, so a model that forgot them is visible;
 *   4. the model recorded on every assistant row, which must be the one the agent reported —
 *      not the first entry of its catalog (a bug this repo shipped once).
 *
 *   node scripts/e2e-real-conversation.mjs -- <agent command>
 *
 * **Spends tokens.** Three short turns against whatever model the agent is configured with.
 * That is why it is not in `pnpm verify` and why the agent is a mandatory argument: this repo
 * presets no agent and no provider.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const ENTRY = join(ROOT, 'dist', 'index.js');

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
if (sep < 0 || sep === argv.length - 1) {
  console.error('usage: node scripts/e2e-real-conversation.mjs -- <agent command…>');
  process.exit(2);
}
const [agentCommand, ...agentArgs] = argv.slice(sep + 1);

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const work = mkdtempSync(join(tmpdir(), 'oac-real-conv-'));
const env = {
  ...process.env,
  // The operator's session map must not gain rows from a test.
  OPENCODE_ACP_CLIENT_SESSION_MAP: join(work, 'sessions.json'),
  // The TUI is not involved here, but the bridge still resolves an opencode binary; a version
  // probe is all it needs, and `--no-tui` means nothing is launched.
  OPENCODE_BIN: process.env['OPENCODE_BIN'] ?? '',
};

console.log(`▸ agent: ${[agentCommand, ...agentArgs].join(' ')}`);
const bridge = spawn(process.execPath, [ENTRY, '--no-tui', '--bridge-port', '5791', work, '--', agentCommand, ...agentArgs], {
  env,
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
});
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

const api = async (url, path, init) => {
  const response = await fetch(`${url}${path}`, init);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { status: response.status, body, text };
};

/** Every assistant row of a session, oldest first, flattened to text. */
const transcript = async (url, session) => {
  const { body } = await api(url, `/api/session/${session}/message`);
  const rows = body?.data ?? [];
  return rows
    .filter((row) => row.type === 'assistant')
    .map((row) => ({
      text: (row.content ?? []).map((part) => part.text ?? '').join(''),
      model: row.model,
      error: row.error?.message,
      done: Boolean(row.time?.completed),
    }))
    .reverse();
};

/** Send one turn and wait until a NEW assistant row has completed. */
async function turn(url, session, id, text) {
  const before = (await transcript(url, session)).length;
  await api(url, `/api/session/${session}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, text }),
  });
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const rows = await transcript(url, session);
    if (rows.length > before && rows[rows.length - 1].done) return rows[rows.length - 1];
    await sleep(500);
  }
  return undefined;
}

let url;
try {
  for (let attempt = 0; attempt < 120 && !url; attempt += 1) {
    const match = /"url":"([^"]+)"/.exec(log);
    if (match) url = match[1];
    else await sleep(250);
  }
  if (!url) {
    bad('the bridge never became ready');
    console.error(log.slice(-600));
    process.exit(1);
  }
  ok('the bridge is up');

  const created = await api(url, '/api/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  const session = created.body?.data?.id;
  if (!session) {
    bad(`no session (HTTP ${created.status})`);
    process.exit(1);
  }
  ok(`session ${session}`);

  // 1. A first turn. The answer is deliberately not echoed back as the prompt text, so one
  //    echo cannot satisfy both the user row and the assistant row.
  const first = await turn(url, session, 'msg_conv_1', 'In one short sentence: what is a protocol?');
  if (!first) {
    bad('the first turn never finished');
  } else if (first.error) {
    bad(`the first turn failed: ${first.error.slice(0, 120)}`);
  } else if (first.text.trim() === '') {
    bad('the first turn produced no text');
  } else {
    ok(`turn 1 answered by the model (${first.text.trim().length} chars)`);
  }

  // 2. The SECOND turn proves context survived. A one-turn smoke cannot: the transcript, the
  //    per-session catalog and the agent's own conversation state are all separate paths.
  const second = await turn(
    url,
    session,
    'msg_conv_2',
    'Now answer with exactly one word: REPEAT. Nothing else.',
  );
  if (!second) bad('the second turn never finished');
  else if (second.error) bad(`the second turn failed: ${second.error.slice(0, 120)}`);
  else if (/repeat/i.test(second.text)) ok('turn 2 answered in the same session (context intact)');
  else bad(`turn 2 answered something else: ${JSON.stringify(second.text.slice(0, 80))}`);

  // 3. A question that can only be answered if the earlier turns are still there.
  const third = await turn(url, session, 'msg_conv_3', 'Which word did I ask you to say in my previous message? Reply with just that word.');
  if (!third) bad('the third turn never finished');
  else if (third.error) bad(`the third turn failed: ${third.error.slice(0, 120)}`);
  else if (/repeat/i.test(third.text)) ok('turn 3 recalled the earlier turn (the session really has history)');
  else bad(`turn 3 did not recall it: ${JSON.stringify(third.text.slice(0, 120))}`);

  // 4. The recorded model must be the one that answered, and the same on every row.
  const rows = await transcript(url, session);
  const models = rows.map((row) => (row.model ? `${row.model.providerID}/${row.model.id}` : '(none)'));
  const unique = [...new Set(models)];
  // ★ `acp/default` is the placeholder; `acp/<anything>` is not. An agent that speaks ACP may
  // legitimately report the provider name `acp` for its own models — `claude-agent-acp`
  // answers `acp/opus`, which is its real selection. An earlier version of this check tested
  // `startsWith('acp/')` and failed a working agent, which is the difference between "the
  // model is unknown" and "the model belongs to an agent that calls itself acp".
  const placeholder = unique.length === 1 && unique[0] === 'acp/default';
  if (unique.length === 1 && unique[0] !== '(none)' && !placeholder) {
    ok(`every row records the same real model: ${unique[0]}`);
  } else {
    bad(`the rows disagree about the model, or it is the placeholder: ${JSON.stringify(unique)}`);
  }

  // 5. The whole conversation is readable back, not just the last turn.
  if (rows.length === 3 && rows.every((row) => row.text.trim() !== '')) {
    ok('all three turns are in the transcript');
  } else {
    bad(`transcript has ${rows.length} assistant row(s), expected 3 with text`);
  }
} finally {
  bridge.kill();
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {
    /* the OS collects temp */
  }
}

console.log(`\n── ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
