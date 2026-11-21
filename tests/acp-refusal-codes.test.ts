/**
 * The REFUSAL codes on the client→agent side of a reverse request.
 *
 * `tests/elicitation.test.ts` covers the shapes we accept. What it did not cover is what we
 * send back when we cannot serve the request at all — and that gap let a real regression
 * through: swapping the hand-written JSON-RPC layer for the official SDK changed the
 * refusal from `-32602 Invalid params` to `-32603 Internal error`, because the SDK only
 * recognises its own `RequestError` type and wraps anything else. Every unit test stayed
 * green; only the smoke run caught it.
 *
 * So this asserts the CODE, not just the fact that an error happened — the shipped client
 * and our own smoke scenario branch on the number.
 */
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { AcpClient } from '../src/acp/client.js';

const FAKE_AGENT = fileURLToPath(new URL('./fake-acp-agent.mjs', import.meta.url));

const clients: AcpClient[] = [];

function makeClient(env: Record<string, string>): AcpClient {
  const client = new AcpClient({
    command: process.execPath,
    args: [FAKE_AGENT],
    env: { FAKE_ACP_SCENARIO: 'rich-turn', ...env },
  });
  clients.push(client);
  return client;
}

afterEach(async () => {
  while (clients.length) await clients.pop()?.dispose();
});

/** The `ELICIT {…}` payload the fixture echoes back, or undefined if it never answered. */
async function elicitReply(env: Record<string, string>): Promise<Record<string, unknown> | undefined> {
  const client = makeClient(env);
  await client.initialize();
  const session = await client.newSession(process.cwd());
  const updates: string[] = [];
  client.on('update', (_id, update) => {
    const content = (update as { content?: { text?: string } }).content;
    if (typeof content?.text === 'string') updates.push(content.text);
  });
  await client.prompt(session.sessionId, [{ type: 'text', text: 'go' }]);
  const text = updates.join('');
  const match = /ELICIT (\{.*\})/s.exec(text);
  return match ? (JSON.parse(match[1]!) as Record<string, unknown>) : undefined;
}

describe('refusing a reverse request we cannot serve', () => {
  it('answers an unadvertised url elicitation with -32602, not -32603', async () => {
    const reply = (await elicitReply({ FAKE_ACP_ELICIT: 'url' })) as
      | { error?: { code?: number; message?: string } }
      | undefined;
    expect(reply?.error).toBeDefined();
    // The number is the contract: `-32603` says "the client broke", `-32602` says "that
    // request is not valid here" — and the agent is entitled to degrade on the second.
    expect(reply?.error?.code).toBe(-32602);
    expect(String(reply?.error?.message)).toMatch(/form elicitation/i);
  });

  it('answers a form elicitation with a result, since that mode IS advertised', async () => {
    // `accept` is spelled in the schema; the fixture only needs SOME result to prove the
    // handler ran instead of refusing.
    const client = makeClient({ FAKE_ACP_ELICIT: 'form' });
    client.onElicitation(async () => ({ action: 'cancel' }));
    await client.initialize();
    const session = await client.newSession(process.cwd());
    const updates: string[] = [];
    client.on('update', (_id, update) => {
      const content = (update as { content?: { text?: string } }).content;
      if (typeof content?.text === 'string') updates.push(content.text);
    });
    await client.prompt(session.sessionId, [{ type: 'text', text: 'go' }]);
    const match = /ELICIT (\{.*\})/s.exec(updates.join(''));
    expect(match).not.toBeNull();
    const reply = JSON.parse(match![1]!) as { error?: unknown; action?: string };
    expect(reply.error).toBeUndefined();
    expect(reply.action).toBe('cancel');
  });
});
