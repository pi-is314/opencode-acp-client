/**
 * The routes the client needs, checked shape by shape — the conformance probes
 * as tests.
 *
 * `scripts/check-openapi.py` still owns the exhaustive, schema-level check
 * (all 42 probes, validated against opencode's published OpenAPI). That one
 * needs Python, `jsonschema` and the network, so it lives in `pnpm verify`
 * rather than in `pnpm test`. What this file adds is that the *shapes we got
 * wrong once* — the ones a real TUI noticed before we did — cannot regress
 * silently on a plain `pnpm test` run:
 *
 *  - `ServerInfo` needs `version`, `pid`, `urls`, `paths` (and no extra `healthy`);
 *  - the envelope's `location` is `{directory}`, not the rich location object;
 *  - `session.active` is a map keyed by *running* sessions, values `{type}`;
 *  - a transcript item is a typed `Session.Message.Info` (id `^msg_`, `type`,
 *    and — for the assistant — `agent`/`model`/`content`), not our internal row;
 *  - the single-message read is one typed message, not an `{info, parts}` pair.
 */
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { BridgeServer, displayAgentCommand } from '../src/server.js';

const FAKE_AGENT = fileURLToPath(new URL('./fake-acp-agent.mjs', import.meta.url));
const servers: BridgeServer[] = [];

async function start(env: Record<string, string> = {}, clientVersion?: string): Promise<string> {
  const server = new BridgeServer({
    command: process.execPath,
    args: [FAKE_AGENT],
    directory: process.cwd(),
    port: 0,
    env,
    ...(clientVersion ? { clientVersion } : {}),
    onLog: () => {},
  });
  servers.push(server);
  const { host, port } = await server.listen();
  return `http://${host}:${port}`;
}

afterEach(async () => {
  while (servers.length) await servers.pop()?.close();
});

const createSession = async (url: string): Promise<string> => {
  const response = await fetch(`${url}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { data: { id: string } }).data.id;
};

describe('the surface the client boots against', () => {
  it('reports ServerInfo with the fields the spec requires', async () => {
    const url = await start();
    const info = (await (await fetch(`${url}/api/info`)).json()) as Record<string, unknown>;
    // Required by `ServerInfo`; a missing `urls`/`paths` is what made the real
    // client's own validation unhappy.
    expect(info).toHaveProperty('version');
    expect(info).toHaveProperty('pid');
    expect(Array.isArray(info.urls)).toBe(true);
    expect(info.paths).toMatchObject({ tmp: expect.any(String) });
    // `additionalProperties: false` — `healthy` used to ride along here.
    expect(info).not.toHaveProperty('healthy');
  });

  it('reports the launcher\'s resolved client version, not a hardcoded hint', async () => {
    // The TUI warns when its own version differs from the server's /api/info
    // version. Hardcoding 2.0.32 made every v2.1 client print
    // "server has version 2.0.32; this client is 2.1.0"; the launcher passes the
    // version it actually resolved before spawning the TUI.
    const url = await start({}, '9.9.9');
    const info = (await (await fetch(`${url}/api/info`)).json()) as { version?: unknown };
    expect(info.version).toBe('9.9.9');
    const health = (await (await fetch(`${url}/api/health`)).json()) as { version?: unknown };
    expect(health.version).toBe('9.9.9');
  });

  it('serves /api/server with the urls a v2.0.0 client dereferences', async () => {
    // opencode v2.0.0's `/pair` screen calls `urls.some(...)` on this route; the
    // bridge did not serve it, answered its shape-correct empty envelope, and the
    // client crashed with `TypeError: undefined is not an object (evaluating
    // 'V.urls.some')`. The schema is exactly `{urls: string[]}`.
    const url = await start();
    const response = await fetch(`${url}/api/server`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { urls?: unknown };
    expect(Array.isArray(body.urls)).toBe(true);
    expect((body.urls as unknown[]).length).toBeGreaterThan(0);
  });

  it('serves both spellings of the health probe', async () => {
    const url = await start();
    // 2.0.27 (and the published spec) probes /api/info; the desktop app's
    // "Add server" flow in current source probes /api/health. A bridge that
    // answers only one of them is incompatible with half the clients.
    const info = (await (await fetch(`${url}/api/info`)).json()) as { version?: unknown };
    expect(typeof info.version).toBe('string');

    const health = await fetch(`${url}/api/health`);
    expect(health.status).toBe(200);
    const body = (await health.json()) as { healthy?: unknown; version?: unknown; pid?: unknown };
    expect(body.healthy).toBe(true);
    expect(typeof body.version).toBe('string');
    expect(typeof body.pid).toBe('number');
  });

  it('answers the routes a client hits before it can render anything', async () => {
    const url = await start();
    for (const route of ['/api/location', '/api/agent', '/api/model', '/api/provider', '/api/config', '/api/form']) {
      const response = await fetch(`${url}${route}`);
      expect(response.status, route).toBe(200);
    }
  });

  it('keeps the envelope location to `{directory}`, as the spec types it', async () => {
    const url = await start();
    const body = (await (await fetch(`${url}/api/provider`)).json()) as {
      location: Record<string, unknown>;
    };
    expect(body.location).toEqual({ directory: expect.any(String) });
    // The rich location belongs to `/api/location` only.
    const rich = (await (await fetch(`${url}/api/location`)).json()) as Record<string, unknown>;
    expect(rich).toHaveProperty('project');
  });
});

describe('the transcript the client reads', () => {
  const runTurn = async (url: string): Promise<string> => {
    const session = await createSession(url);
    await fetch(`${url}/api/session/${session}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'remember this line' }),
    });
    // The turn runs in the background; the reply is a few events away.
    for (let i = 0; i < 100; i += 1) {
      const body = (await (await fetch(`${url}/api/session/${session}/message`)).json()) as {
        data: Array<{ type?: string }>;
      };
      if (body.data?.some((item) => item.type === 'assistant')) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return session;
  };

  it('serves typed messages, with the user text the client renders', async () => {
    const url = await start({ FAKE_ACP_MODELS: '1', FAKE_ACP_REPLY: 'PONG_FROM_AGENT' });
    const session = await runTurn(url);
    const body = (await (await fetch(`${url}/api/session/${session}/message`)).json()) as {
      data: Array<Record<string, unknown>>;
      cursor: { previous: unknown; next: unknown };
    };

    expect(body.cursor).toHaveProperty('previous');
    for (const item of body.data) {
      expect(String(item.id)).toMatch(/^msg_/);
      expect(['user', 'assistant']).toContain(item.type);
    }

    const user = body.data.find((item) => item.type === 'user');
    // A user row with empty text renders as a blank line — the bug the real TUI
    // exposed after the first projection rewrite.
    expect(user?.text).toBe('remember this line');

    const assistant = body.data.find((item) => item.type === 'assistant');
    expect(assistant).toHaveProperty('agent');
    expect(assistant?.model).toMatchObject({ providerID: expect.any(String) });
    expect(Array.isArray(assistant?.content)).toBe(true);
  });

  it('serves one typed message from the single-message route', async () => {
    const url = await start({ FAKE_ACP_MODELS: '1', FAKE_ACP_REPLY: 'PONG_FROM_AGENT' });
    const session = await runTurn(url);
    const list = (await (await fetch(`${url}/api/session/${session}/message`)).json()) as {
      data: Array<{ id: string; type: string }>;
    };
    const first = list.data[0]!;

    const body = (await (
      await fetch(`${url}/api/session/${session}/message/${first.id}`)
    ).json()) as { data: Record<string, unknown> };

    // `{data: Session.Message.Info}` — not our old `{data: {info, parts}}`.
    expect(body.data).toMatchObject({ id: first.id, type: first.type });
    expect(body.data).not.toHaveProperty('info');
  });

  it('reports only running sessions in the active map, with SessionActive values', async () => {
    const url = await start();
    await createSession(url);
    const body = (await (await fetch(`${url}/api/session/active`)).json()) as {
      data: Record<string, { type?: string }>;
    };
    for (const [id, value] of Object.entries(body.data)) {
      expect(id).toMatch(/^ses_/);
      expect(value).toMatchObject({ type: 'running' });
    }
  });
});

describe('v2.2.0 additions', () => {
  it('answers /api/experimental/usage/limits with the declared null', async () => {
    // v2.2.0's TUI reads the location's Console budgets on startup. ACP has no Console, and
    // the route's schema is `UsageLimits.Info | null` — an empty array is the wrong shape and
    // used to fall through to the catch-all while logging "unhandled route".
    const url = await start();
    const response = await fetch(`${url}/api/experimental/usage/limits`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { location?: unknown; data?: unknown };
    expect(body.location).toEqual({ directory: expect.any(String) });
    expect(body.data).toBeNull();
  });

  it('names every model as a chat model and filters on `types`', async () => {
    // v2.2.0 made models typed and `GET /api/model` lists `chat` by default.
    const url = await start({ FAKE_ACP_MODELS: '1' });
    const all = (await (await fetch(`${url}/api/model`)).json()) as { data: Array<{ type?: string }> };
    expect(all.data.length).toBeGreaterThan(0);
    expect(all.data.every((model) => model.type === 'chat')).toBe(true);

    const chatOnly = (await (await fetch(`${url}/api/model?types=chat`)).json()) as { data: unknown[] };
    expect(chatOnly.data.length).toBe(all.data.length);

    const imageOnly = (await (await fetch(`${url}/api/model?types=image`)).json()) as { data: unknown[] };
    expect(imageOnly.data).toEqual([]);
  });
});

describe('the reasoning-effort option reaches the model picker', () => {
  it('reads an option the agent calls `effort`, not only `thought_level`', async () => {
    // ★ The option's name belongs to the agent; only its category is the spec's. Matching the
    // name alone made an agent that calls it `effort` show no variants at
    // all, so thinking could not be switched on from the TUI and the session stayed silent.
    const url = await start({ FAKE_ACP_MODELS: '1', FAKE_ACP_EFFORT: '1' });
    // The variants are read from a LIVE session's config options, so one has to exist.
    await createSession(url);
    const models = (await (await fetch(`${url}/api/model`)).json()) as {
      data: Array<{ providerID?: string; variants?: Array<{ id: string }> }>;
    };
    const real = models.data.find((model) => model.providerID !== 'acp');
    expect(real?.variants?.map((variant) => variant.id)).toEqual(['off', 'high', 'max']);
  });
});

describe('naming the agent when it does not name itself', () => {
  it('shows the launch command, masked and capped', () => {
    // ACP makes `agentInfo` a SHOULD, so an agent that says nothing used to appear as
    // `acp`. The launch command is always true — but it is on screen, so secrets in named
    // flags are masked and a long invocation is truncated.
    expect(displayAgentCommand('dsh --profile acp')).toBe('dsh --profile acp');
    // An absolute path would spend the whole footer width on one directory.
    expect(displayAgentCommand('node /Users/me/deep/tree/agent.mjs')).toBe('node agent.mjs');
    expect(displayAgentCommand('agent --api-key sk-123 --verbose')).toBe('agent --api-key *** --verbose');
    expect(displayAgentCommand('agent --token=abc')).toBe('agent --token=***');
    expect(displayAgentCommand('npx -y @scope/something-quite-long --flag value')).toBe(
      'npx -y @scope/something-quite-long --flag value',
    );
    const long = displayAgentCommand(`npx -y ${'x'.repeat(120)}`);
    expect(long.length).toBe(80);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('a shell event id', () => {
  it('carries the evt_ prefix both client generations strip', () => {
    // A `!command` renders only when the row's messageID matches the store's message.
    // Both the store (`SessionMessage.ID.fromEvent`) and the TUI rows derive it as
    // `event.id.replace(/^evt_/, "msg_")`, so a bare `sh_…` event id produced a row that
    // pointed at `sh_…` while the message is `msg_sh_…`: v2.2 resolves the message before
    // rendering and dropped the row entirely (measured: no row at all for `!command`).
    const server = new BridgeServer({
      command: process.execPath,
      args: [FAKE_AGENT],
      directory: process.cwd(),
      port: 0,
      env: {},
      onLog: () => {},
    });
    const id = (server as unknown as { eventIdForShell(id: string): string }).eventIdForShell('sh_probe');
    expect(id).toBe('evt_sh_probe');
    expect(id.replace(/^evt_/, 'msg_')).toBe('msg_sh_probe');
    // Already-prefixed ids are left alone.
    expect((server as unknown as { eventIdForShell(id: string): string }).eventIdForShell('evt_sh_x')).toBe('evt_sh_x');
  });
});
