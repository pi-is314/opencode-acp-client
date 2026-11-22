#!/usr/bin/env node
/**
 * A protocol round-trip against a real (fake) ACP agent over real HTTP, on any platform.
 *
 * Why this exists next to the unit suite: everything else that drives the bridge end to end is
 * a bash script with tmux in it, so none of it can run on Windows — where the bridge's process,
 * path and shell assumptions are the least exercised. This is the same shape as
 * `scripts/e2e-real-agent.sh` (start the bridge, let it reach ACP, assert the catalog is REAL
 * rather than the `acp/default` placeholder) reduced to what Node itself can do, so the one
 * platform without a bash still gets a wire-level check.
 *
 * It asserts the protocol, not a model's prose:
 *   • the bridge reports a ready line with a usable URL;
 *   • the agent's ACP handshake completed — the catalog carries REAL models, not the
 *     placeholder, which is the evidence that `initialize` + `session/new` really answered;
 *   • a prompt produces a turn that settles, and the agent's own words reach the transcript;
 *   • a model switch through `/api/session/:id/model` is answered by the agent;
 *   • an interrupt is answered `200 {interrupted}`, not silently accepted.
 *
 *   node scripts/e2e-protocol.mjs            # builds nothing; run `pnpm build` first
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const FAKE_AGENT = join(ROOT, 'tests', 'fake-acp-agent.mjs');
const ENTRY = join(ROOT, 'dist', 'index.js');

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

const work = mkdtempSync(join(tmpdir(), 'oac-proto-'));
const env = {
  ...process.env,
  // A throwaway session map: the real one belongs to the person running this.
  OPENCODE_ACP_CLIENT_SESSION_MAP: join(work, 'sessions.json'),
  // A real catalog is the point of the first assertion, and that is what this switch gives.
  FAKE_ACP_MODELS: '1',
};

const bridge = spawn(process.execPath, [ENTRY, '--no-tui', '--bridge-port', '0'.replace('0', '5659'), work, '--', process.execPath, FAKE_AGENT], {
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let log = '';
bridge.stdout.on('data', (chunk) => {
  log += String(chunk);
});
bridge.stderr.on('data', (chunk) => {
  log += String(chunk);
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForUrl(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = /"type":"ready","url":"([^"]+)"/.exec(log);
    if (match) return match[1];
    await sleep(200);
  }
  return undefined;
}

async function api(url, path, init) {
  const response = await fetch(`${url}${path}`, init);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { status: response.status, body, text };
}

const cleanup = () => {
  bridge.kill();
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {
    /* Windows may still hold it; the OS cleans temp eventually */
  }
};

try {
  console.log(`▸ bridge: ${ENTRY}`);
  console.log(`▸ agent:  ${FAKE_AGENT}`);
  const url = await waitForUrl();
  if (!url) {
    bad('the bridge printed no ready line');
    console.error(log.slice(-800));
    cleanup();
    process.exit(1);
  }
  ok(`ready on ${url}`);

  // 2. A session and a turn.
  const created = await api(url, '/api/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  const session = created.body?.data?.id;
  if (session) ok(`session created: ${session}`);
  else bad(`session creation failed (HTTP ${created.status}): ${created.text.slice(0, 200)}`);

  if (session) {
    const prompt = await api(url, `/api/session/${session}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'msg_proto_1', text: 'hello from the protocol check' }),
    });
    // The HTTP response is a placeholder in the same shape as a normal turn — that is the
    // contract (see docs/ARCHITECTURE.md); the turn itself streams.
    if (prompt.status < 400) ok(`prompt accepted (HTTP ${prompt.status})`);
    else bad(`prompt rejected (HTTP ${prompt.status}): ${prompt.text.slice(0, 200)}`);

    let settled = false;
    let text = '';
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const { body } = await api(url, `/api/session/${session}/message`);
      const rows = body?.data ?? [];
      const assistant = rows.find((row) => row.type === 'assistant');
      text = (assistant?.content ?? []).map((part) => part.text ?? '').join('');
      if (assistant?.time?.completed) {
        settled = true;
        break;
      }
      await sleep(250);
    }
    if (settled) ok('the turn settled (the agent answered session/prompt)');
    else bad('the turn never settled: no completed assistant message');
    if (/you said: hello from the protocol check/.test(text)) ok("the agent's reply reached the transcript");
    else bad(`the transcript does not carry the reply (got: ${text.slice(0, 120)})`);

  // 1. The catalog is REAL. Before any session reaches ACP, `/api/model` answers a single
  //    placeholder (`acp/default`); a real one is the evidence the handshake happened. This is
  //    the same trap the bash script documents: counting entries instead of checking the id
  //    mistakes the placeholder for success.
  let models = [];
  for (let attempt = 0; attempt < 60 && models.length === 0; attempt += 1) {
    const { body } = await api(url, '/api/model');
    models = ((body?.data ?? [])).filter(
      (model) => !(model.providerID === 'acp' && model.id === 'default'),
    );
    if (models.length === 0) await sleep(250);
  }
  if (models.length > 0) ok(`the agent's catalog arrived (${models.length} model(s), not the acp/default placeholder)`);
  else bad('the catalog never left the placeholder: initialize/session/new did not answer');

    // 3. A model switch, answered by the agent rather than 204d away.
    const target = models[0];
    if (target?.id) {
      const switched = await api(url, `/api/session/${session}/model`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: { providerID: target.providerID ?? 'acp', id: target.id } }),
      });
      if (switched.status < 400) ok(`model switch answered (HTTP ${switched.status})`);
      else bad(`model switch refused (HTTP ${switched.status}): ${switched.text.slice(0, 160)}`);
    }

    // 4. An interrupt is answered with a shape, never a bare 204. The real client logs
    //    `UnexpectedStatus: 204` on every cancel — that regression is what this guards.
    const interrupted = await api(url, `/api/session/${session}/interrupt`, { method: 'POST' });
    const shape = interrupted.body;
    if (interrupted.status === 200 && typeof shape?.interrupted === 'boolean') {
      ok(`interrupt answered 200 {interrupted: ${String(shape.interrupted)}}`);
    } else {
      bad(`interrupt answered HTTP ${interrupted.status}, not 200 {interrupted: boolean}`);
    }
  }
} finally {
  cleanup();
}

console.log(`\n── ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
