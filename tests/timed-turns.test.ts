import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BridgeEvent } from '../src/contract.js';
import { BridgeServer } from '../src/server.js';

/**
 * Turns observed WHILE they run, not after they finish.
 *
 * Most of this suite runs a turn to completion and then asserts on the result. That cannot
 * see a state the bridge passed through on the way — and twice now a bug lived exactly
 * there (a tool card stuck on "Writing command…", a finished call pushed back to pending).
 * Zed's harness solves it with channels: `agent.send_request(…)` → assert the UI state →
 * send the next frame. The fake agent here is a separate process, so the same effect comes
 * from a gate file: the agent blocks until the test creates `<gate>.<label>`.
 */
const FAKE_AGENT = join(import.meta.dirname, 'fake-acp-agent.mjs');

const servers: BridgeServer[] = [];
afterEach(async () => {
  while (servers.length) await servers.pop()?.close();
});

/** Everything the bridge publishes, in order, for one session. */
async function openEvents(url: string) {
  const response = await fetch(`${url}/api/event`);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const events: BridgeEvent[] = [];
  let buffer = '';
  void (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = block
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('\n');
        if (data) events.push(JSON.parse(data) as BridgeEvent);
        boundary = buffer.indexOf('\n\n');
      }
    }
  })();
  return {
    events,
    of: (type: string) => events.filter((event) => event.type === type),
    stop: () => void reader.cancel(),
  };
}

async function startGated(extra: Record<string, string> = {}) {
  const work = mkdtempSync(join(tmpdir(), 'acp-gate-'));
  const gate = join(work, 'gate');
  const server = new BridgeServer({
    command: process.execPath,
    args: [FAKE_AGENT],
    directory: process.cwd(),
    port: 0,
    env: { FAKE_ACP_MODELS: '1', FAKE_ACP_TOOL: '1', FAKE_ACP_GATE: gate, ...extra },
    onLog: () => {},
  });
  servers.push(server);
  const { host, port } = await server.listen();
  const url = `http://${host}:${port}`;
  return { url, open: (label: string) => writeFileSync(`${gate}.${label}`, '') };
}

async function createSession(url: string): Promise<string> {
  const response = await fetch(`${url}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  const body = (await response.json()) as { data: { id: string } };
  return body.data.id;
}

/** Poll until `check` holds; the fake agent is another process, so nothing here is instant. */
async function until(check: () => boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for a condition');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('a turn observed while it runs', () => {
  it('publishes the tool row before the call has finished', async () => {
    const { url, open } = await startGated();
    const session = await createSession(url);
    const stream = await openEvents(url);

    // The agent is parked before it emits its first tool frame; the client sees nothing yet.
    const prompt = fetch(`${url}/api/session/${session}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'msg_gate_1', text: 'go', files: [], agents: [], delivery: 'steer' }),
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(stream.of('session.tool.input.started')).toHaveLength(0);

    // Release the tool frames: the row must appear while the turn is still open.
    open('before-tool');
    await until(() => stream.of('session.tool.input.started').length > 0);
    expect(stream.of('session.execution.succeeded')).toHaveLength(0);

    // Release the completion; only now may the turn settle.
    open('before-complete');
    await prompt;
    await until(() => stream.of('session.execution.succeeded').length > 0);
    stream.stop();
  }, 20_000);

  it('does not report success before the agent has answered', async () => {
    // A hung turn is the same fact with no gate: nothing settles, and the bridge must not
    // invent a completion to make the UI calm.
    const { url, open } = await startGated({ FAKE_ACP_HANG: '1' });
    void open;
    const session = await createSession(url);
    const stream = await openEvents(url);
    void fetch(`${url}/api/session/${session}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'msg_gate_2', text: 'go', files: [], agents: [], delivery: 'steer' }),
    }).catch(() => undefined);

    await until(() => stream.of('session.execution.started').length > 0);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(stream.of('session.execution.succeeded')).toHaveLength(0);
    expect(stream.of('session.execution.failed')).toHaveLength(0);
    stream.stop();
  }, 20_000);
});
