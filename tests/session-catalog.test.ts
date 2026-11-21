/**
 * Each session's catalog is its own.
 *
 * ACP scopes config options (models, reasoning effort…) to a session: `session/new`,
 * `session/load` and `session/resume` each carry their own list, and
 * `session/set_config_option` targets one session. The bridge kept them in a single
 * field while one connection meant one session; now that a connection can host many
 * sessions, a single field lets the newest session's defaults — or a switch meant for
 * another session — leak across.
 *
 * Asserted here, on the client, because the bug is bookkeeping: nothing in the HTTP
 * surface would show it until a shared connection exists.
 */
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { AcpClient } from '../src/acp/client.js';

const FAKE_AGENT = fileURLToPath(new URL('./fake-acp-agent.mjs', import.meta.url));

const clients: AcpClient[] = [];

function makeClient(): AcpClient {
  const client = new AcpClient({
    command: process.execPath,
    args: [FAKE_AGENT],
    env: { FAKE_ACP_MODELS: '1' },
    onLog: () => {},
  });
  clients.push(client);
  return client;
}

/** The `model` option's value as the agent advertised it, e.g. `["fake","model-1"]`. */
function modelValue(client: AcpClient, sessionId?: string): string | undefined {
  const option = client
    .configOptionsFor(sessionId)
    .find((entry) => (entry.id ?? (entry as { configId?: string }).configId) === 'model');
  return option?.currentValue === undefined ? undefined : String(option.currentValue);
}

afterEach(async () => {
  while (clients.length) await clients.pop()?.dispose();
});

describe('per-session catalogs on one connection', () => {
  it('keeps two sessions apart through new/set_config', async () => {
    const client = makeClient();
    await client.initialize();
    const a = await client.newSession(process.cwd());
    const b = await client.newSession(process.cwd());

    expect(modelValue(client, a.sessionId)).toBe('["fake","model-1"]');
    expect(modelValue(client, b.sessionId)).toBe('["fake","model-1"]');

    // A switch meant for A must not touch B…
    await client.setConfig(a.sessionId, 'model', '["fake","model-2"]');
    expect(modelValue(client, a.sessionId)).toBe('["fake","model-2"]');
    expect(modelValue(client, b.sessionId)).toBe('["fake","model-1"]');

    // …and the compat getter tracks the most recently touched session.
    expect(modelValue(client)).toBe('["fake","model-2"]');

    // An agent-pushed config state lands on the session it names, and only there.
    client.applyConfigOptions(b.sessionId, [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: '["fake","model-2"]',
        options: [],
      },
    ]);
    expect(modelValue(client, b.sessionId)).toBe('["fake","model-2"]');
    expect(modelValue(client, a.sessionId)).toBe('["fake","model-2"]');
  });
});
