// Throwaway: what model does a finished turn record? `(agent)` runs under `pnpm probe:model -- <agent>`.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [command, ...args] = process.argv.slice(2);
const cwd = mkdtempSync(join(tmpdir(), 'pmt-'));
const bridge = spawn(process.execPath, ['dist/index.js', '--no-tui', '--bridge-port', '7792', cwd, '--', command, ...args], {
  env: process.env,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let ready = '';
const waitReady = new Promise((resolve) => {
  bridge.stdout.on('data', (d) => {
    ready += d;
    const m = ready.match(/"url":"([^"]+)"/);
    if (m && !ready.done) { ready.done = true; resolve(m[1]); }
  });
});
const base = await waitReady;
const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const session = await post('/api/session', { directory: cwd });
await post(`/api/session/${session.data.id}/prompt`, { id: 'm1', text: 'Reply with exactly: OK' }).catch((e) => console.error('prompt:', String(e).slice(0, 120)));
await new Promise((r) => setTimeout(r, 4000));
const rows = await fetch(`${base}/api/session/${session.data.id}/message`).then((r) => r.json());
for (const m of rows.data ?? []) if (m.model) console.log('message model:', JSON.stringify(m.model));
bridge.kill();
process.exit(0);
