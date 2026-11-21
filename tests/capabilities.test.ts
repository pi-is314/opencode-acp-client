import { describe, expect, it } from 'vitest';

import {
  CLIENT_CAPABILITIES,
  NO_CAPABILITIES,
  canListSessions,
  canLoadSession,
  canResumeSession,
  clientCallbackSupport,
  displayName,
  effectiveCapabilities,
  filterPromptBlocks,
} from '../src/acp/capabilities.js';

describe('effectiveCapabilities', () => {
  it('treats an absent initialize result as the minimal profile', () => {
    const caps = effectiveCapabilities(undefined);
    expect(caps.loadSession).toBe(false);
    expect(caps.images).toBe(false);
    expect(caps.reported).toBe(false);
  });

  it('does not invent capabilities an agent omitted', () => {
    // The realistic case: an agent answers initialize but advertises little.
    const caps = effectiveCapabilities({ agentCapabilities: {} });
    expect(caps.loadSession).toBe(false);
    expect(caps.images).toBe(false);
    expect(caps.reported).toBe(true);
    expect(caps.agentName).toBe('unknown');
  });

  it('reads sessionCapabilities.resume, which decides how a restore behaves', () => {
    // The backend's plain ACP profile: resume + list + close, and NO loadSession.
    const plain = effectiveCapabilities({
      agentCapabilities: { sessionCapabilities: { resume: {}, list: {}, close: {} } },
    });
    expect(plain.resumeSessions).toBe(true);
    expect(plain.loadSession).toBe(false);
    expect(canResumeSession(plain).allowed).toBe(true);
    // Enhanced profile: loadSession, and no resume.
    const enhanced = effectiveCapabilities({
      agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} } },
    });
    expect(enhanced.resumeSessions).toBe(false);
    expect(canResumeSession(enhanced).allowed).toBe(false);
    // Present-but-null is "not supported", exactly as for list.
    const nulled = effectiveCapabilities({
      agentCapabilities: { sessionCapabilities: { resume: null } },
    });
    expect(nulled.resumeSessions).toBe(false);
  });

  it('keeps one literal for the "nothing advertised yet" profile', () => {
    // A second hand-written copy of this object in AcpClient went stale the moment
    // a field was added (the compiler caught it, but the shape was still duplicated).
    expect(effectiveCapabilities(undefined)).toEqual(NO_CAPABILITIES);
    expect(NO_CAPABILITIES.resumeSessions).toBe(false);
  });

  it('reads the advertised fields', () => {
    const caps = effectiveCapabilities({
      agentCapabilities: { loadSession: true, promptCapabilities: { image: true } },
      agentInfo: { name: 'rich-agent' },
    });
    expect(caps.loadSession).toBe(true);
    expect(caps.images).toBe(true);
    expect(caps.embeddedContext).toBe(false);
    expect(caps.agentName).toBe('rich-agent');
  });
});

describe('canLoadSession', () => {
  it('refuses when the agent did not advertise loadSession', () => {
    const decision = canLoadSession(effectiveCapabilities({ agentCapabilities: {} }));
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('session/load');
  });
});

/**
 * ACP: "Before attempting to list sessions, Clients **MUST** verify that the
 * Agent supports this capability by checking the `sessionCapabilities.list` field
 * in the `initialize` response … If `sessionCapabilities.list` is not present,
 * the Agent does not support listing sessions and Clients **MUST NOT** attempt to
 * call `session/list`."
 */
describe('session/list gating', () => {
  it('is unsupported unless the agent advertises it', () => {
    const bare = effectiveCapabilities({ agentCapabilities: {} });
    expect(bare.listSessions).toBe(false);
    expect(canListSessions(bare).allowed).toBe(false);
    expect(canListSessions(bare).reason).toContain('sessionCapabilities.list');
  });

  it('is supported when the field is present and non-null', () => {
    const caps = effectiveCapabilities({ agentCapabilities: { sessionCapabilities: { list: {} } } });
    expect(caps.listSessions).toBe(true);
    expect(canListSessions(caps).allowed).toBe(true);
  });

  it('treats an explicit null as unsupported, per the spec', () => {
    const caps = effectiveCapabilities({
      agentCapabilities: { sessionCapabilities: { list: null } },
    });
    expect(caps.listSessions).toBe(false);
  });
});

describe('filterPromptBlocks', () => {
  const bare = effectiveCapabilities({ agentCapabilities: {} });

  it('drops unsupported block types rather than forwarding them', () => {
    const { kept, dropped } = filterPromptBlocks(
      [{ type: 'text', text: 'hi' }, { type: 'image', data: 'x' }],
      bare,
    );
    expect(kept).toHaveLength(1);
    expect(dropped).toEqual(['image']);
  });

  it('keeps image blocks when the agent advertises them', () => {
    const rich = effectiveCapabilities({ agentCapabilities: { promptCapabilities: { image: true } } });
    const { kept, dropped } = filterPromptBlocks([{ type: 'image', data: 'x' }], rich);
    expect(kept).toHaveLength(1);
    expect(dropped).toEqual([]);
  });

  it('drops a block type it does not know instead of forwarding it', () => {
    // The agent's schema may reject an unknown block and fail the whole turn;
    // text is the one every agent takes.
    const { kept, dropped } = filterPromptBlocks(
      [{ type: 'text', text: 'hi' }, { type: 'mystery', data: 1 }],
      bare,
    );
    expect(kept.map((b) => b.type)).toEqual(['text']);
    expect(dropped).toEqual(['mystery']);
  });

  it('keeps resource_link without embeddedContext, because it is baseline in ACP', () => {
    // Only embedded *content* (`resource`) needs the capability; a link to one is
    // something every agent must handle.
    const { kept, dropped } = filterPromptBlocks(
      [{ type: 'resource_link', uri: 'file:///x' }, { type: 'resource', resource: {} }],
      bare,
    );
    expect(kept.map((b) => b.type)).toEqual(['resource_link']);
    expect(dropped).toEqual(['resource']);
  });
});

describe('clientCallbackSupport', () => {
  it('refuses filesystem callbacks we never advertised', () => {
    expect(clientCallbackSupport('fs/read_text_file').supported).toBe(false);
  });

  it('refuses terminal callbacks we never advertised', () => {
    expect(clientCallbackSupport('terminal/create').supported).toBe(false);
  });
});

/**
 * The guard: **every capability we announce must have a path
 * that honours it** ("只宣告能兑现的能力").
 *
 * This is deliberately written as a two-way check rather than a snapshot of the
 * object, so that adding a capability to `CLIENT_CAPABILITIES` without wiring the
 * method that services it fails here — and so that a mode we do not announce
 * cannot quietly become servable.
 */
describe('advertised client capabilities', () => {
  it('advertises exactly the modes that are implemented', () => {
    // Both `_meta` entries are negotiated dialects with a path behind them, not the
    // `terminal/*` capability:
    //   • `terminal_output` — `toolOutput` reads `_meta.terminal_output.data`; Zed
    //     announces the same key;
    //   • `opencode/child-session-updates` — `applyChildUpdate` consumes the delegated
    //     run's frames (`subagent-sessions.ts`); the key is the adapter's own
    //     (`packages/cli/src/acp/event.ts`), and only an agent that lists it sends them.
    expect(CLIENT_CAPABILITIES).toEqual({
      elicitation: { form: {} },
      _meta: { terminal_output: true, 'opencode/child-session-updates': true },
    });
  });

  it('does not advertise the surfaces and modes we deliberately lack', () => {
    const caps = CLIENT_CAPABILITIES as Record<string, unknown>;
    // No filesystem or terminal implementation exists to back these.
    expect(caps.fs).toBeUndefined();
    expect(caps.terminal).toBeUndefined();
    // No browser surface for url mode; no opencode v2 surface for notices or
    // compaction. Announcing them would only produce updates nothing renders.
    for (const absent of ['url', 'notices', 'compaction']) {
      expect(JSON.stringify(caps)).not.toContain(absent);
    }
  });

  it('services the one method the announcement promises', () => {
    // `elicitation.form` -> `elicitation/create` (form mode) is serviced by an
    // explicit branch in `AcpClient.onRequest`; the mode gate is covered by the
    // url-mode scenario in `scripts/e2e-smoke.sh`.
    expect(clientCallbackSupport('elicitation/create').supported).toBe(true);
  });

  it('treats everything it does not advertise as refused, not unknown', () => {
    // `supported: false` is what produces an explicit -32601 rather than a hang,
    // so an unadvertised callback must never fall through to the permissive default.
    for (const method of ['fs/read_text_file', 'fs/write_text_file', 'terminal/create', 'terminal/output']) {
      expect(clientCallbackSupport(method).supported).toBe(false);
      expect(clientCallbackSupport(method).reason.length).toBeGreaterThan(0);
    }
  });
});

describe('choosing the name to show for an agent', () => {
  it('prefers the human-readable title over the programmatic name', () => {
    // ACP: `title` is for the UI, `name` is for programmatic use, and the name is only a
    // display fallback. Reading `name` alone showed an agent's id in the footer.
    expect(displayName({ name: 'my-agent', title: 'DeepSeek Harness' })).toBe('DeepSeek Harness');
  });

  it('falls back to the name, then to "unknown"', () => {
    expect(displayName({ name: 'acp' })).toBe('acp');
    expect(displayName({ title: '   ' })).toBe('unknown');
    expect(displayName(undefined)).toBe('unknown');
  });
});
