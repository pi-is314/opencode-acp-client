/**
 * Replaying recorded real-agent frames through the translator.
 *
 * The synthetic fake agent can only exercise shapes we thought of. A corpus
 * recorded from a real agent (`scripts/record-acp-frames.mjs`) carries the shapes
 * the agent actually sends, and the `.expected.json` beside it is the gate: it
 * fails when a translator change alters what a turn becomes.
 *
 * Corpus format (KiroCrew's): first line is `_meta` provenance
 * (`backend`, `recorded: live|synthesized`, `date`, `agent_version`), then the
 * wire verbatim. Add or refresh a fixture by recording, never by hand.
 *
 *   UPDATE_FRAME_SNAPSHOTS=1 npx vitest run tests/frame-replay.test.ts
 *
 * rewrites the snapshots. By default this test only reads.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { Location } from '../src/contract.js';
import type { SessionUpdate } from '../src/acp/types.js';
import { BridgeState } from '../src/state.js';
import { AcpTranslator } from '../src/translate/events.js';
import { projectMessage } from '../src/project.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/acp_frames', import.meta.url));
const LOCATION: Location = {
  directory: '/tmp/recorded',
  project: { id: 'p', directory: '/tmp/recorded', canonical: '/tmp/recorded' },
};

interface Frame {
  method?: string;
  params?: { sessionId?: string; update?: SessionUpdate };
  result?: unknown;
  error?: { message?: string };
}

/** Replay only the `session/update` notifications; responses drive the server, not the translator. */
function replay(frames: Frame[]): unknown[] {
  const state = new BridgeState();
  const sink = {
    emit(event: Record<string, unknown>) {
      const framed = { ...event, id: `e` };
      return framed;
    },
  };
  const translator = new AcpTranslator(state, sink, LOCATION, () => {});
  const record = state.createSession(LOCATION);
  translator.beginTurn(record);
  for (const frame of frames) {
    if (frame.method === 'session/update' && frame.params?.update) {
      translator.apply(record, frame.params.update);
    }
  }
  translator.endTurn(record);
  return record.messages.map((message) =>
    normalize(
      projectMessage(message, state.partsOf(record, message.id), {
        agent: 'recorded',
        model: { providerID: 'recorded', modelID: 'recorded' },
      }),
    ),
  );
}

/** Drop ids, clocks and payload bytes: the shape of the turn is what a snapshot guards. */
function normalize(message: Record<string, unknown>): unknown {
  const content = Array.isArray(message['content'])
    ? (message['content'] as Array<Record<string, unknown>>).map((part) => {
        if (part['type'] === 'text' || part['type'] === 'reasoning') {
          return { type: part['type'], text: part['text'] };
        }
        if (part['type'] === 'tool') {
          return { type: 'tool', name: part['name'], status: (part['state'] as { status?: string } | undefined)?.status };
        }
        return { type: part['type'] };
      })
    : undefined;
  return {
    role: message['role'],
    type: message['type'],
    ...(typeof message['text'] === 'string' ? { text: message['text'] } : {}),
    ...(typeof message['agent'] === 'string' ? { agent: message['agent'] } : {}),
    ...(content ? { content } : {}),
    ...(message['error'] !== undefined ? { error: message['error'] } : {}),
  };
}

/** A committed fixture must not carry a home path or an obvious credential. */
function assertRedacted(raw: string, where: string): void {
  const home = homedir();
  if (home && raw.includes(home)) {
    throw new Error(`${where} contains the recording host's home directory (${home}); redact it`);
  }
  if (/\/(Users|home)\/[A-Za-z0-9._-]+/.test(raw)) {
    throw new Error(`${where} contains a home path; redact it`);
  }
  if (/\b(sk|ghp|xox[abp])[-_][A-Za-z0-9]{12,}/.test(raw)) {
    throw new Error(`${where} looks like it contains a credential; redact it`);
  }
}

const cases: Array<{ backend: string; file: string }> = [];
for (const backend of readdirSync(FIXTURES)) {
  const dir = join(FIXTURES, backend);
  if (!statSync(dir).isDirectory()) continue;
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.jsonl'))) {
    cases.push({ backend, file: join(dir, file) });
  }
}

describe('recorded frame corpus', () => {
  it('has at least one fixture', () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  for (const { backend, file } of cases) {
    it(`${backend}/${file.split('/').pop()} replays to its committed snapshot`, () => {
      const raw = readFileSync(file, 'utf8');
      assertRedacted(raw, `${backend}/${file.split('/').pop()}`);
      const lines = raw.trim().split('\n');
      const meta = (JSON.parse(lines[0]!) as { _meta?: Record<string, unknown> })._meta;
      expect(meta?.['backend']).toBeTruthy();
      expect(['live', 'synthesized']).toContain(meta?.['recorded']);
      expect(typeof meta?.['agent_version']).toBe('string');

      const frames = lines.slice(1).map((line) => JSON.parse(line) as Frame);
      const snapshot = replay(frames);
      const expectedPath = file.replace(/\.jsonl$/, '.expected.json');
      if (process.env['UPDATE_FRAME_SNAPSHOTS'] === '1') {
        writeFileSync(expectedPath, `${JSON.stringify(snapshot, null, 2)}\n`);
      }
      expect(snapshot).toEqual(JSON.parse(readFileSync(expectedPath, 'utf8')));
    });
  }
});
