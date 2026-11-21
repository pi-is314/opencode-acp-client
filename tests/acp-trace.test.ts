/**
 * `OPENCODE_ACP_CLIENT_TRACE` records BOTH directions.
 *
 * It used to log only `[recv]` — what the agent said — and nothing about what we asked. A
 * disagreement with an agent then looked like "the agent refuses a perfectly good request",
 * when the request itself carried a field the schema spells differently. `[send]` is the other
 * half of every such debugging session, so it is asserted here rather than assumed.
 */
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { AcpClient } from '../src/acp/client.js';

const FAKE_AGENT = fileURLToPath(new URL('./fake-acp-agent.mjs', import.meta.url));

const clients: AcpClient[] = [];

function makeClient(lines: string[]): AcpClient {
  const client = new AcpClient({
    command: process.execPath,
    args: [FAKE_AGENT],
    env: { FAKE_ACP_SCENARIO: 'rich-turn' },
  });
  // `on('log')` is the real subscription — the same one `src/server.ts` uses to prefix the
  // bridge's log with `[acp]`. (`AcpClientOptions.onLog` exists but nothing consumes it.)
  client.on('log', (line) => lines.push(line));
  clients.push(client);
  return client;
}

afterEach(async () => {
  while (clients.length) await clients.pop()?.dispose();
  delete process.env['OPENCODE_ACP_CLIENT_TRACE'];
});

describe('the ACP trace', () => {
  it('records the frames we send as well as the ones we receive', async () => {
    process.env['OPENCODE_ACP_CLIENT_TRACE'] = '1';
    const lines: string[] = [];
    const client = makeClient(lines);
    await client.initialize();
    await client.newSession(process.cwd());

    const sent = lines.filter((line) => line.startsWith('[send] '));
    const received = lines.filter((line) => line.startsWith('[recv] '));

    // Both directions, and both non-empty: the outbound half is the point of this test.
    expect(sent.length).toBeGreaterThan(0);
    expect(received.length).toBeGreaterThan(0);

    // The frames are the real ones, parseable JSON-RPC, naming the method we called.
    const parsed = sent.map((line) => JSON.parse(line.slice('[send] '.length)) as Record<string, unknown>);
    expect(parsed.map((frame) => frame['method'])).toEqual(
      expect.arrayContaining(['initialize', 'session/new']),
    );
    for (const frame of parsed) {
      expect(frame['jsonrpc']).toBe('2.0');
    }
  });

  it('honours the `onLog` option, which used to be silently ignored', async () => {
    // The option was declared and passed by two call sites but never consumed, so the ACP
    // frames of the session-discovery client went nowhere. This pins the wiring.
    process.env['OPENCODE_ACP_CLIENT_TRACE'] = '1';
    const seen: string[] = [];
    const client = new AcpClient({
      command: process.execPath,
      args: [FAKE_AGENT],
      env: { FAKE_ACP_SCENARIO: 'rich-turn' },
      onLog: (line) => seen.push(line),
    });
    clients.push(client);
    await client.initialize();

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.some((line) => line.startsWith('[send] '))).toBe(true);
  });

  it('stays silent when the switch is off', async () => {
    delete process.env['OPENCODE_ACP_CLIENT_TRACE'];
    const lines: string[] = [];
    const client = makeClient(lines);
    await client.initialize();

    expect(lines.filter((line) => line.startsWith('[send] '))).toEqual([]);
    expect(lines.filter((line) => line.startsWith('[recv] '))).toEqual([]);
  });

  it('truncates a long frame instead of dumping megabytes into the log', async () => {
    process.env['OPENCODE_ACP_CLIENT_TRACE'] = '1';
    const lines: string[] = [];
    const client = makeClient(lines);
    const session = await client.newSession(process.cwd());
    // A prompt large enough to exceed the 4000-character cap on its own.
    await client
      .prompt(session.sessionId, [{ type: 'text', text: 'x'.repeat(10_000) }])
      .catch(() => undefined);

    const sent = lines.filter((line) => line.startsWith('[send] '));
    expect(sent.length).toBeGreaterThan(0);
    expect(Math.max(...sent.map((line) => line.length))).toBeLessThan(4_100);
  });
});
