#!/usr/bin/env node
/**
 * Record one real turn into a replayable ACP frame corpus.
 *
 *   AGENT="dsh --profile acp" SCENARIO=turn node scripts/record-acp-frames.mjs
 *
 * Runs the bridge against the agent in a throwaway workspace, sends one short
 * prompt, and moves the recorded `<dir>/<backend>.jsonl` to
 * `tests/fixtures/acp_frames/<backend>/<scenario>.jsonl`. The frames are the
 * agent's own wire bytes with a provenance header first (see the recorder in
 * `src/acp/client.ts`). Nothing else is written into the workspace.
 */
import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { BridgeServer } from '../dist/server.js';

const command = process.env.AGENT ?? 'dsh --profile acp';
const [cmd, ...args] = command.split(' ');
const scenario = process.env.SCENARIO ?? 'turn';
const prompt = process.env.PROMPT ?? 'Reply with exactly: hi';
const recorded = resolve(process.env.RECORD_DIR ?? '.cache/acp-frames');
const workspace = mkdtempSync(join(tmpdir(), 'oac-record-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

rmSync(recorded, { recursive: true, force: true });
process.env.OPENCODE_ACP_CLIENT_RECORD_FRAMES = recorded;
// Keep the operator's real session map out of it: a recording is a throwaway run.
process.env.OPENCODE_ACP_CLIENT_SESSION_MAP = join(workspace, 'sessions.json');

const server = new BridgeServer({ command: cmd, args, directory: workspace, port: 0 });
const { host, port } = await server.listen();
const base = `http://${host}:${port}`;
let status = 1;
try {
  const created = await fetch(`${base}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  const session = (await created.json()).data.id;
  const turn = fetch(`${base}/api/session/${session}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: prompt }),
  });
  // The prompt HTTP response is a placeholder, so it is not a completion signal.
  // First wait for the turn to APPEAR in the active map (it may start after the
  // POST returned), then for it to clear — otherwise an early poll reads "not
  // active" and the recording is cut off mid-turn.
  const appears = Date.now() + 15_000;
  while (Date.now() < appears) {
    const active = await (await fetch(`${base}/api/session/active`)).json();
    if (session in (active.data ?? {})) break;
    await sleep(200);
  }
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    const active = await (await fetch(`${base}/api/session/active`)).json();
    if (!(session in (active.data ?? {}))) break;
    await sleep(500);
  }
  await turn.catch(() => {});
  // Some agents finish the turn (and clear the active map) before their last
  // frames land; a short settle window is what makes the recording complete.
  await sleep(Number(process.env.SETTLE_MS ?? 4000));
  const messages = await (await fetch(`${base}/api/session/${session}/message`)).json();
  console.log(`turns settled; ${(messages.data ?? []).length} message(s) projected`);
  status = 0;
} finally {
  await server.close();
  rmSync(workspace, { recursive: true, force: true });
}

const files = readdirSync(recorded).filter((name) => name.endsWith('.jsonl'));
if (files.length !== 1) {
  console.error(`expected one recorded file, got ${files.length}`);
  process.exit(1);
}
const dest = join('tests/fixtures/acp_frames', files[0].replace(/\.jsonl$/, ''), `${scenario}.jsonl`);
mkdirSync(dirname(dest), { recursive: true });
renameSync(join(recorded, files[0]), dest);
console.log(`recorded ${dest}`);
process.exit(status);
