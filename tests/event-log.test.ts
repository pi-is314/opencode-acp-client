import { afterEach, describe, expect, it, vi } from 'vitest';

import { SseHub } from '../src/sse.js';

/**
 * `OPENCODE_ACP_CLIENT_EVENT_LOG=1` records WHICH session every emitted event names.
 *
 * It exists because a report of "a brand-new tab showed a message belonging to an older
 * one" cannot be settled from the bridge log: that log proves every REQUEST reached the
 * right session, and says nothing about the events we emit. Without this, "the bridge
 * published the wrong sessionID" and "the client drew it in the active tab" look
 * identical.
 */
describe('the event log', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('names the addressed session for every event when enabled', () => {
    vi.stubEnv('OPENCODE_ACP_CLIENT_EVENT_LOG', '1');
    const lines: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line: string) => void lines.push(line));
    const hub = new SseHub();
    hub.emit({ type: 'session.text.delta', data: { sessionID: 'ses_a', text: 'x' } } as never);
    hub.emit({ type: 'session.updated', data: { session: { id: 'ses_b' } } } as never);
    expect(lines[0]).toContain('session.text.delta sid=ses_a');
    // An event without a top-level sessionID is marked, not guessed: silently printing
    // the enclosing one would hide exactly the mismatch this switch is looking for.
    expect(lines[1]).toContain('session.updated sid=-');
  });

  it('stays quiet unless the switch is on', () => {
    vi.stubEnv('OPENCODE_ACP_CLIENT_EVENT_LOG', '');
    vi.stubEnv('OPENCODE_ACP_CLIENT_TRACE', '');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    new SseHub().emit({ type: 'session.updated', data: { session: { id: 'ses_a' } } } as never);
    expect(spy).not.toHaveBeenCalled();
  });
});
