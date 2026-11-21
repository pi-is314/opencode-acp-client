/**
 * Recording a real turn into a replayable corpus.
 *
 * `OPENCODE_ACP_CLIENT_RECORD_FRAMES=<dir>` writes every inbound frame to
 * `<dir>/<backend>.jsonl`, with a provenance line first. The point is a fixture
 * that carries the agent's OWN shapes: the synthetic fake agent can only exercise
 * shapes we thought of, while a recorded corpus catches a translator change that
 * breaks on what a real backend sends.
 *
 * Asserted here on the client, because the recorder lives on the wire path.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { AcpClient } from '../src/acp/client.js';

const FAKE_AGENT = fileURLToPath(new URL('./fake-acp-agent.mjs', import.meta.url));

const clients: AcpClient[] = [];

afterEach(async () => {
  while (clients.length) await clients.pop()?.dispose();
});

describe('frame recording', () => {
  it('writes a provenance header and the wire verbatim', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oac-frames-'));
    const previous = process.env['OPENCODE_ACP_CLIENT_RECORD_FRAMES'];
    process.env['OPENCODE_ACP_CLIENT_RECORD_FRAMES'] = dir;
    try {
      const client = new AcpClient({
        command: process.execPath,
        args: [FAKE_AGENT],
        env: { FAKE_ACP_MODELS: '1' },
        onLog: () => {},
      });
      clients.push(client);
      await client.initialize();
      await client.newSession(process.cwd());

      const file = join(dir, 'fake-acp.jsonl');
      const lines = readFileSync(file, 'utf8').trim().split('\n');
      const header = JSON.parse(lines[0]!) as {
        _meta?: { backend?: string; recorded?: string; date?: string; agent_version?: string };
      };
      expect(header._meta?.backend).toBe('fake-acp');
      expect(header._meta?.recorded).toBe('live');
      expect(header._meta?.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(typeof header._meta?.agent_version).toBe('string');

      // Everything after the header is a JSON-RPC frame, verbatim.
      const frames = lines.slice(1).map((line) => JSON.parse(line) as { jsonrpc?: string });
      expect(frames.length).toBeGreaterThan(0);
      expect(frames.every((frame) => frame.jsonrpc === '2.0')).toBe(true);
      // The outbound `session/new` is not recorded (only inbound frames are); its
      // response is, and it names the agent's session id.
      expect(lines.join('\n')).toContain('fake-session-1');
    } finally {
      if (previous === undefined) delete process.env['OPENCODE_ACP_CLIENT_RECORD_FRAMES'];
      else process.env['OPENCODE_ACP_CLIENT_RECORD_FRAMES'] = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
