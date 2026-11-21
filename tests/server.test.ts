import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdCompressSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';

import { get as httpGet, type IncomingMessage } from 'node:http';

import { BridgeServer } from '../src/server.js';

const FAKE_AGENT = fileURLToPath(new URL('./fake-acp-agent.mjs', import.meta.url));

const servers: BridgeServer[] = [];

async function start(
  env: Record<string, string> = {},
  resumeSession?: string,
): Promise<{ url: string; server: BridgeServer }> {
  const server = new BridgeServer({
    command: process.execPath,
    args: [FAKE_AGENT],
    directory: process.cwd(),
    port: 0,
    env,
    onLog: () => {},
    ...(resumeSession ? { resumeSession } : {}),
  });
  servers.push(server);
  const { host, port } = await server.listen();
  return { url: `http://${host}:${port}`, server };
}

afterEach(async () => {
  while (servers.length) {
    const server = servers.pop();
    await server?.close();
  }
});

/**
 * A live SSE subscription over `node:http`.
 *
 * `fetch` is deliberately not used here: inside vitest a `text/event-stream`
 * body does not stream chunk by chunk — the reads never resolve, so every
 * assertion times out no matter how correct the bridge is. That is why these
 * cases were skipped while `scripts/e2e-smoke.sh` (raw sockets through curl)
 * passed the same flows. `http.get` gives a real socket, so the gap closes
 * instead of being worked around, and the assertions do not change.
 */
interface StreamEvent {
  id: string;
  type: string;
  data: unknown;
}

function subscribe(url: string, lastEventId?: string): {
  events: StreamEvent[];
  /** Resolves once the hub has registered us — see the note on `ready` below. */
  ready: Promise<void>;
  until: (predicate: (types: string[]) => boolean, timeoutMs?: number) => Promise<StreamEvent[]>;
  close: () => void;
} {
  const events: StreamEvent[] = [];
  const waiters: Array<() => void> = [];
  let buffer = '';
  let response: IncomingMessage | undefined;
  // `httpGet` connects asynchronously: without this, a test that subscribes and
  // immediately acts can lose the very first events to a subscription that is
  // not registered yet. The handler runs `hub.connect()` before writing the
  // response head, so headers arriving means we are in the fan-out list.
  let markReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });

  const request = httpGet(
    `${url}/api/event`,
    lastEventId ? { headers: { 'Last-Event-ID': lastEventId } } : {},
    (incoming) => {
      response = incoming;
      markReady();
      incoming.setEncoding('utf8');
    incoming.on('data', (chunk: string) => {
      buffer += chunk;
      let index = buffer.indexOf('\n\n');
      while (index >= 0) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const line = frame.split('\n').find((l) => l.startsWith('data: '));
        if (line) {
          try {
            events.push(JSON.parse(line.slice(6)) as StreamEvent);
          } catch {
            /* a frame split across chunks: the next read completes it */
          }
        }
        for (const wake of waiters.splice(0)) wake();
        index = buffer.indexOf('\n\n');
      }
    });
    },
  );
  // The test closes this on purpose; an error afterwards is not a failure.
  request.on('error', () => {});

  return {
    events,
    ready,
    async until(predicate, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      while (!predicate(events.map((event) => event.type)) && Date.now() < deadline) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 25);
          waiters.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
      return events;
    },
    close() {
      response?.destroy();
      request.destroy();
    },
  };
}

function openStream(url: string, lastEventId?: string) {
  return subscribe(url, lastEventId);
}

/** Read SSE frames until `predicate` matches or the deadline passes. */
async function readEvents(
  url: string,
  predicate: (types: string[]) => boolean,
  timeoutMs = 10_000,
): Promise<StreamEvent[]> {
  const stream = subscribe(url);
  try {
    return await stream.until(predicate, timeoutMs);
  } finally {
    stream.close();
  }
}

describe('SSE-driven flows', () => {
  it('serves the handshake the client waits for on /api/event', async () => {
    const { url } = await start();
    const events = await readEvents(url, (types) => types.includes('server.connected'));
    expect(events[0]).toMatchObject({ type: 'server.connected' });
  });

  it('replays missed durable events after reconnecting with Last-Event-ID', async () => {
    const { url } = await start();
    const first = openStream(url);
    try {
      await first.ready;
      const firstSession = await createSession(url);
      await first.until((types) => types.includes('session.created'));
      const seen = first.events.find(
        (event) => event.type === 'session.created' && JSON.stringify(event.data).includes(firstSession),
      );
      expect(seen).toBeDefined();

      // The official TUI reconnects its event stream and re-synchronizes active state. The
      // bridge side of that contract is: handshake again, then replay only frames after the
      // supplied event id, in order. Create the next session while no client is connected.
      first.close();
      const missedSession = await createSession(url);
      const second = openStream(url, seen!.id);
      try {
        await second.ready;
        await second.until((types) => types.includes('session.created'));
        expect(second.events[0]).toMatchObject({ type: 'server.connected' });
        const replayed = second.events.find(
          (event) => event.type === 'session.created' && JSON.stringify(event.data).includes(missedSession),
        );
        expect(replayed).toBeDefined();
        expect(second.events.some((event) => event.id === seen!.id)).toBe(false);

        const sessions = (await (await fetch(`${url}/api/session`)).json()) as {
          data: Array<{ id: string }>;
        };
        expect(sessions.data.map((session) => session.id)).toContain(missedSession);
      } finally {
        second.close();
      }
    } finally {
      first.close();
    }
  });

  it('replays a permission settlement and leaves no stale pending permission after reconnect', async () => {
    const { url } = await start({ FAKE_ACP_PERMISSION: 'allow', FAKE_ACP_REPLY: 'done' });
    const session = await createSession(url);
    const first = openStream(url);
    try {
      await first.ready;
      await prompt(url, session, 'needs permission');
      await first.until((types) => types.includes('permission.asked'));
      const asked = first.events.find((event) => event.type === 'permission.asked');
      expect(asked).toBeDefined();
      const requestId = (asked!.data as { id: string }).id;
      first.close();

      const reply = await fetch(`${url}/api/session/${session}/permission/${requestId}/reply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ optionId: 'allow-once' }),
      });
      expect(reply.status).toBe(204);

      const second = openStream(url, asked!.id);
      try {
        await second.ready;
        await second.until((types) => types.includes('permission.replied'));
        expect(second.events.some((event) => event.type === 'permission.replied')).toBe(true);
        const pending = (await (await fetch(`${url}/api/permission/request`)).json()) as { data: unknown[] };
        expect(pending.data).toEqual([]);
      } finally {
        second.close();
      }
    } finally {
      first.close();
    }
  });

  it('replays a form cancellation and leaves no stale pending form after reconnect', async () => {
    const { url } = await start({ FAKE_ACP_ELICIT: 'form' });
    const session = await createSession(url);
    const first = openStream(url);
    try {
      await first.ready;
      await prompt(url, session, 'needs a form');
      await first.until((types) => types.includes('form.created'));
      const created = first.events.find((event) => event.type === 'form.created');
      expect(created).toBeDefined();
      const formId = (created!.data as { form: { id: string } }).form.id;
      first.close();

      const cancel = await fetch(`${url}/api/session/${session}/form/${formId}/cancel`, { method: 'POST' });
      expect(cancel.status).toBe(204);
      const second = openStream(url, created!.id);
      try {
        await second.ready;
        await second.until((types) => types.includes('form.cancelled'));
        expect(second.events.some((event) => event.type === 'form.cancelled')).toBe(true);
        const global = (await (await fetch(`${url}/api/form`)).json()) as { data: unknown[] };
        const scoped = (await (await fetch(`${url}/api/session/${session}/form`)).json()) as { data: unknown[] };
        expect(global.data).toEqual([]);
        expect(scoped.data).toEqual([]);
      } finally {
        second.close();
      }
    } finally {
      first.close();
    }
  });

  it('answers the routes the client needs to start', async () => {
    const { url } = await start();
    const path = await (await fetch(`${url}/path`)).json();
    expect(path).toHaveProperty('directory');
    expect(path).toHaveProperty('worktree');

    const providers = await (await fetch(`${url}/config/providers`)).json();
    expect(providers).toHaveProperty('providers');

    // These must be arrays/objects, never 404: several client screens die on 404.
    for (const route of ['/agent', '/command', '/lsp', '/formatter']) {
      const res = await fetch(`${url}${route}`);
      expect(res.status, route).toBe(200);
      expect(Array.isArray(await res.json()), route).toBe(true);
    }
  });

  it('reports callbacks we never advertised as errors, not silence', async () => {
    const { url } = await start({ FAKE_ACP_CALLBACK: 'fs/read_text_file', FAKE_ACP_REPLY: 'ok' });
    const session = await createSession(url);
    // Subscribe before acting: the hub replays a bounded ring, and a subscriber
    // that arrives afterwards races the very events it means to assert on.
    const reader = openStream(url);
    try {
      await reader.ready;
      await prompt(url, session, 'go');
      // Wait for the turn to *finish*: a callback left unanswered hangs the
      // agent, so "turn.idle arrived" is the assertion that matters. Which frame
      // carries the echo is not: an early `part.updated` has no text yet, and
      // asserting on the first one was this test's own bug.
      const events = await reader.until((types) => types.includes('turn.idle'));
      expect(events.some((event) => JSON.stringify(event).includes('callback:'))).toBe(true);
    } finally {
      reader.close();
    }
  });
});

describe('bridge sessions', () => {
  it('creates a session and lists it back', async () => {
    const { url } = await start();
    const session = await createSession(url);
    expect(session).toMatch(/^ses_/);
    const list = await (await fetch(`${url}/api/session`)).json();
    expect(list.data.map((s: { id: string }) => s.id)).toContain(session);
  });



  it('announces a new session on the event stream', async () => {
    const { url } = await start();
    // Subscribe first so the creation event is observed live, then act.
    const reader = openStream(url);
    try {
      await reader.ready;
      const session = await createSession(url);
      const events = await reader.until((types) => types.includes('session.created'));
      const created = events.find((e) => e.type === 'session.created');
      expect(created).toBeTruthy();
      expect(JSON.stringify(created)).toContain(session);
    } finally {
      reader.close();
    }
  });

  it('records terminal outcome and acknowledges only the observed idle watermark', async () => {
    const { url } = await start({ FAKE_ACP_REPLY: 'done' });
    const session = await createSession(url);
    const reader = openStream(url);
    try {
      await reader.ready;
      await prompt(url, session, 'finish me');
      await reader.until((types) => types.includes('session.execution.succeeded'));
      const info = (await (await fetch(`${url}/api/session/${session}`)).json()) as {
        data: { outcome?: string; time: { idle?: number; viewed?: number } };
      };
      expect(info.data.outcome).toBe('succeeded');
      expect(info.data.time.idle).toEqual(expect.any(Number));

      const view = await fetch(`${url}/api/session/${session}/view`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ idle: info.data.time.idle }),
      });
      expect(view.status).toBe(204);
      const events = await reader.until((types) => types.includes('session.viewed'));
      const viewed = events.find((event) => event.type === 'session.viewed');
      expect(viewed?.data).toMatchObject({ sessionID: session, idle: info.data.time.idle });
      const acknowledged = (await (await fetch(`${url}/api/session/${session}`)).json()) as {
        data: { time: { idle?: number; viewed?: number } };
      };
      expect(acknowledged.data.time.viewed).toBe(acknowledged.data.time.idle);

      // A stale acknowledgement is a harmless 204 but must not claim a newer terminal
      // transition has been viewed.
      const stale = await fetch(`${url}/api/session/${session}/view`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ idle: (info.data.time.idle ?? 0) - 1 }),
      });
      expect(stale.status).toBe(204);
      const afterStale = (await (await fetch(`${url}/api/session/${session}`)).json()) as {
        data: { time: { idle?: number; viewed?: number } };
      };
      expect(afterStale.data.time.viewed).toBe(info.data.time.idle);
    } finally {
      reader.close();
    }
  });

  it('streams a reply as deltas and finishes the turn', async () => {
    const { url } = await start({ FAKE_ACP_REPLY: 'hello world', FAKE_ACP_CHUNK_SIZE: '5' });
    const session = await createSession(url);
    const reader = openStream(url);
    try {
      await reader.ready;
      await prompt(url, session, 'hi');
      const events = await reader.until((types) => types.includes('turn.idle'), 10_000);
      expect(events.filter((e) => e.type === 'message.part.delta').length).toBeGreaterThan(0);
      expect(events.some((e) => e.type === 'turn.wait')).toBe(true);
      expect(events.some((e) => e.type === 'turn.idle')).toBe(true);
    } finally {
      reader.close();
    }
  });

  it('surfaces a permission request and accepts a reply', async () => {
    const { url } = await start({ FAKE_ACP_PERMISSION: 'allow', FAKE_ACP_REPLY: 'done' });
    const session = await createSession(url);
    // One subscription for the whole flow: the hub does not replay its ring to a
    // subscriber that arrives later, so a second `readEvents` after the reply
    // could never see the earlier `permission.replied` — which is exactly how
    // this test used to fail.
    const reader = openStream(url);
    try {
      await reader.ready;
      await prompt(url, session, 'do it');

      const asked = await reader.until((types) => types.includes('permission.asked'));
      const event = asked.find((e) => e.type === 'permission.asked');
      expect(event).toBeTruthy();
      const requestId = (event!.data as { id: string }).id;

      const reply = await fetch(`${url}/api/session/${session}/permission/${requestId}/reply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ optionId: 'allow-once' }),
      });
      expect(reply.status).toBe(204);

      // A second reply is an expired request. The official TUI suite has a case for a
      // permission that expired before its reply, and it needs a terminal answer: a silent
      // 204 leaves the dialog believing it answered. The form route already answers 404 here.
      const expired = await fetch(`${url}/api/session/${session}/permission/${requestId}/reply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ optionId: 'allow-once' }),
      });
      expect(expired.status).toBe(404);

      const settled = await reader.until((types) => types.includes('turn.idle'));
      expect(settled.some((e) => e.type === 'permission.replied')).toBe(true);
    } finally {
      reader.close();
    }
  });

  it('answers with a 400 when a prompt has no parts', async () => {
    const { url } = await start();
    const session = await createSession(url);
    const res = await fetch(`${url}/api/session/${session}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('adopts an unknown session instead of pretending — and says so if the agent cannot', async () => {
    const { url } = await start();
    const res = await fetch(`${url}/api/session/does-not-exist/message`);
    expect(res.status).toBe(404);
  });
});

// ------------------------------------------------------------------ helpers

/**
 * Wait until the bridge reports this session as running. A fixed sleep before an interrupt
 * guessed how fast a turn starts, and under a full-suite load the guess lost: the interrupt
 * landed before the turn was busy and was answered `{interrupted: false}` — a failure that
 * appeared only when the whole suite ran, never alone.
 */
async function waitUntilRunning(url: string, sessionId: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const active = (await (await fetch(`${url}/api/session/active`)).json()) as { data?: Record<string, unknown> };
    if (active.data && sessionId in active.data) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`session ${sessionId} never became active`);
}

async function createSession(url: string): Promise<string> {
  const res = await fetch(`${url}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'test' }),
  });
  const body = (await res.json()) as { data: { id: string } };
  return body.data.id;
}

async function prompt(url: string, sessionId: string, text: string): Promise<void> {
  await fetch(`${url}/api/session/${sessionId}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ parts: [{ type: 'text', text }] }),
  });
}

describe('session.interrupt', () => {
  /**
   * The client decodes `{interrupted: boolean}` here and treats anything else as
   * a protocol error — the real TUI logged `UnexpectedStatus: 204` on every
   * cancel while this route answered `noContent()`.
   */
  const createSession = async (url: string): Promise<string> => {
    const response = await fetch(`${url}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    return ((await response.json()) as { data: { id: string } }).data.id;
  };

  it('does not leave an optimistic user row after a rejected prompt', async () => {
    const { url } = await start();
    const session = await createSession(url);
    const rejected = await fetch(`${url}/api/session/${session}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'msg_rejected_prompt', parts: [] }),
    });
    expect(rejected.status).toBe(400);
    const transcript = (await (await fetch(`${url}/api/session/${session}/message`)).json()) as {
      data: Array<{ id: string }>;
    };
    expect(transcript.data.map((message) => message.id)).not.toContain('msg_rejected_prompt');
  });

  it('answers 200 with a body, and an idle session is not "interrupted"', async () => {
    const { url } = await start();
    const sessionID = await createSession(url);

    const interrupted = await fetch(`${url}/api/session/${sessionID}/interrupt`, { method: 'POST' });
    expect(interrupted.status).toBe(200);
    expect(await interrupted.json()).toEqual({ interrupted: false });

    // The older spelling keeps working, with the same body.
    const legacy = await fetch(`${url}/api/session/${sessionID}/abort`, { method: 'POST' });
    expect(legacy.status).toBe(200);
    expect(await legacy.json()).toEqual({ interrupted: false });
  });

  it('reports true while a turn is running, and settles it', async () => {
    const { url } = await start({ FAKE_ACP_HANG: '1' });
    const sessionID = await createSession(url);

    // Not awaited yet: this turn never ends on its own.
    const pending = fetch(`${url}/api/session/${sessionID}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hold this open' }),
    });
    await waitUntilRunning(url, sessionID);

    const interrupted = await fetch(`${url}/api/session/${sessionID}/interrupt`, { method: 'POST' });
    expect(interrupted.status).toBe(200);
    expect(await interrupted.json()).toEqual({ interrupted: true });

    // Cancelling is what lets the prompt request finish at all.
    expect((await pending).status).toBe(200);
  });

  it('interrupts only the targeted session while another session remains active', async () => {
    const { url } = await start({ FAKE_ACP_HANG: '1' });
    const first = await createSession(url);
    const second = await createSession(url);
    const firstPrompt = fetch(`${url}/api/session/${first}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hold first' }),
    });
    const secondPrompt = fetch(`${url}/api/session/${second}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hold second' }),
    });
    await waitUntilRunning(url, first);
    await waitUntilRunning(url, second);

    const before = (await (await fetch(`${url}/api/session/active`)).json()) as { data: Record<string, unknown> };
    expect(before.data).toHaveProperty(first);
    expect(before.data).toHaveProperty(second);

    const interrupted = await fetch(`${url}/api/session/${first}/interrupt`, { method: 'POST' });
    expect(await interrupted.json()).toEqual({ interrupted: true });
    // Prompt HTTP is only an acknowledgement; wait for the agent cancellation callback to
    // run translator.endTurn and remove the first session from the active snapshot.
    expect((await firstPrompt).status).toBe(200);
    let after: { data: Record<string, unknown> } | undefined;
    for (let attempt = 0; attempt < 30; attempt++) {
      after = (await (await fetch(`${url}/api/session/active`)).json()) as { data: Record<string, unknown> };
      if (!(first in after.data)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(after!.data).not.toHaveProperty(first);
    expect(after!.data).toHaveProperty(second);

    await fetch(`${url}/api/session/${second}/interrupt`, { method: 'POST' });
    expect((await secondPrompt).status).toBe(200);
  });
});
