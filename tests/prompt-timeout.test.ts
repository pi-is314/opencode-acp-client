/**
 * The clock a prompt runs on.
 *
 * This exists because a real user's review task died mid-flight against a real
 * agent: our bridge timed `session/prompt` out after 120s of silence while the
 * agent was still working, and the turn ended with `timed out waiting for
 * session/prompt`. One timeout served every request, which is wrong — control
 * requests answer in milliseconds, a prompt is a task.
 *
 * It is asserted here, at the level the timeout lives, because attempts through
 * the HTTP surface kept hitting unrelated teardown noise and proved nothing.
 */
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { AcpClient } from '../src/acp/client.js';

const FAKE_AGENT = fileURLToPath(new URL('./fake-acp-agent.mjs', import.meta.url));

const clients: AcpClient[] = [];

function makeClient(options: { promptTimeoutMs?: number; requestTimeoutMs?: number }): AcpClient {
  const client = new AcpClient({
    command: process.execPath,
    args: [FAKE_AGENT],
    // Answers initialize and session/new, then never answers a prompt.
    env: { FAKE_ACP_HANG: '1' },
    onLog: () => {},
    ...options,
  });
  clients.push(client);
  return client;
}

afterEach(async () => {
  while (clients.length) await clients.pop()?.dispose();
});

describe('the clock a prompt runs on', () => {
  it('fails a silent prompt as a prompt timeout', async () => {
    const client = makeClient({ promptTimeoutMs: 400 });
    await client.initialize();
    const session = await client.newSession(process.cwd());

    await expect(
      client.prompt(session.sessionId, [{ type: 'text', text: 'go' }]),
    ).rejects.toThrow(/timed out waiting for session\/prompt/);
  });

  it('does not let the prompt clock govern a control request', async () => {
    // The direction that would make the other fix a bug: a very short prompt
    // timeout must not shorten initialize or session/new.
    const client = makeClient({ promptTimeoutMs: 1, requestTimeoutMs: 10_000 });
    await expect(client.initialize()).resolves.toBeTruthy();
    await expect(client.newSession(process.cwd())).resolves.toBeTruthy();
  });
});
