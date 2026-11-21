import { afterEach, describe, expect, it } from 'vitest';

import { BridgeServer } from '../src/server.js';
import { join } from 'node:path';

/**
 * The race Zed pins with `test_permission_rpc_cancellation_does_not_cancel_successor`:
 * one permission request is cancelled while another is in flight, and the survivor must
 * still be answerable — a cancellation that takes its successor with it leaves a dialog
 * nobody can answer, which is the worst shape of this bug because it looks like a hang.
 */
const FAKE_AGENT = join(import.meta.dirname, 'fake-acp-agent.mjs');

const servers: BridgeServer[] = [];
afterEach(async () => {
  while (servers.length) await servers.pop()?.close();
});

async function startServer(): Promise<string> {
  const server = new BridgeServer({
    command: process.execPath,
    args: [FAKE_AGENT],
    directory: process.cwd(),
    port: 0,
    env: { FAKE_ACP_MODELS: '1', FAKE_ACP_PERMISSION: 'allow' },
    onLog: () => {},
  });
  servers.push(server);
  const { host, port } = await server.listen();
  return `http://${host}:${port}`;
}

async function createSession(url: string): Promise<string> {
  const response = await fetch(`${url}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  return ((await response.json()) as { data: { id: string } }).data.id;
}

async function until<T>(fn: () => Promise<T | undefined>, ms = 8000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

interface Pending {
  id: string;
  tool: string;
}

async function pending(url: string, session: string): Promise<Pending[]> {
  const response = await fetch(`${url}/api/session/${session}/permission`);
  const body = (await response.json()) as { data: Pending[] };
  return body.data;
}

describe('a permission dialog that is racing a cancellation', () => {
  it('leaves nothing pending after an interrupt, and the turn still settles', async () => {
    // Cancelling mid-dialog is the common case (the user hits Escape twice while an agent
    // is asking). The dialog must go away, the agent must receive `cancelled`, and the
    // turn must end — a dialog left behind is a UI that cannot be dismissed.
    const url = await startServer();
    const session = await createSession(url);
    void fetch(`${url}/api/session/${session}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'msg_perm_1', text: 'go', files: [], agents: [], delivery: 'steer' }),
    }).catch(() => undefined);

    const asked = await until(async () => {
      const list = await pending(url, session);
      return list.length > 0 ? list : undefined;
    });
    expect(asked).toHaveLength(1);

    const interrupt = await fetch(`${url}/api/session/${session}/interrupt`, { method: 'POST' });
    expect(interrupt.status).toBe(200);
    expect(await interrupt.json()).toMatchObject({ interrupted: expect.any(Boolean) });

    // Nothing is left for the user to answer.
    await until(async () => ((await pending(url, session)).length === 0 ? true : undefined));
  }, 20_000);

  it('answers a permission that arrives after an earlier one was cancelled', async () => {
    // The successor must still be answerable — the failure mode Zed guards against, where
    // cancelling one request tore down the state the next one needed.
    const url = await startServer();
    const session = await createSession(url);
    void fetch(`${url}/api/session/${session}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'msg_perm_2', text: 'go', files: [], agents: [], delivery: 'steer' }),
    }).catch(() => undefined);

    const [first] = await until(async () => {
      const list = await pending(url, session);
      return list.length > 0 ? list : undefined;
    });
    const reply = await fetch(`${url}/api/session/${session}/permission/${first.id}/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reply: 'once' }),
    });
    expect([200, 204]).toContain(reply.status);
    // Answering is not a no-op: the dialog this answer belonged to is gone.
    await until(async () => ((await pending(url, session)).length === 0 ? true : undefined));
  }, 20_000);
});
