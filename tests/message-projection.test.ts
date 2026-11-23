/**
 * The transcript as the client reads it.
 *
 * `GET /api/session/:id/message` is `Session.Message.Info[]`: typed messages with
 * their content inline. Serving our internal `{id, sessionID, role, time}` rows
 * instead is what made a reopened session render an empty transcript under the
 * real opencode v2.0.27 TUI — live turns were fine because they ride the SSE
 * events, and only reading went through these routes.
 */
import { describe, expect, it } from 'vitest';

import { projectMessage, specMessageId } from '../src/project.js';
import type { Message, Part, ToolPart } from '../src/contract.js';

const message = (role: 'user' | 'assistant', extra: Partial<Message> = {}): Message => ({
  id: role === 'user' ? 'msg_u1' : 'msg_a1',
  sessionID: 'ses_1',
  role,
  time: { created: 1000, completed: 2000 },
  ...extra,
});

const text = (value: string): Part => ({
  id: 'prt_t1', sessionID: 'ses_1', messageID: 'msg_a1', type: 'text', text: value,
});

const reasoning = (value: string): Part => ({
  id: 'prt_r1', sessionID: 'ses_1', messageID: 'msg_a1', type: 'reasoning', text: value,
  time: { start: 1000 },
});

const tool = (state: ToolPart['state']): ToolPart => ({
  id: 'prt_x1', sessionID: 'ses_1', messageID: 'msg_a1', type: 'tool',
  callID: 'call-1', tool: 'bash', state,
});

const context = { agent: 'fake-acp', model: { providerID: 'fake', modelID: 'model-1' } };

describe('specMessageId', () => {
  it('gives a replayed id the prefix the spec requires, and leaves a live one alone', () => {
    expect(specMessageId('rep_a_0')).toBe('msg_rep_a_0');
    expect(specMessageId('msg_mv123')).toBe('msg_mv123');
  });
});

describe('projectMessage', () => {
  it('makes a user turn a Session.Message.User, with its text on the message', () => {
    const projected = projectMessage(message('user'), [text('hello '), text('there')], context);
    expect(projected).toMatchObject({ type: 'user', text: 'hello there', role: 'user' });
    expect(projected.id).toMatch(/^msg_/);
    // `Session.Message.User.time` carries `created` only.
    expect(projected.time).toEqual({ created: 1000 });
  });

  it('makes an assistant turn a Session.Message.Assistant with content in order', () => {
    const projected = projectMessage(message('assistant'), [text('hi'), reasoning('hmm')], context);
    expect(projected).toMatchObject({
      type: 'assistant',
      agent: 'fake-acp',
      model: { id: 'model-1', providerID: 'fake' },
      time: { created: 1000, completed: 2000 },
    });
    expect(projected.content?.map((item) => item.type)).toEqual(['text', 'reasoning']);
  });

  it('projects a finished tool with its output as content', () => {
    const projected = projectMessage(
      message('assistant'),
      [tool({ status: 'completed', input: { command: 'ls' }, output: 'a\nb', time: { start: 5, end: 9 } })],
      context,
    );
    expect(projected.content?.[0]).toMatchObject({
      type: 'tool',
      id: 'prt_x1',
      name: 'bash',
      state: { status: 'completed', input: { command: 'ls' }, content: [{ type: 'text', text: 'a\nb' }] },
      time: { created: 5, completed: 9 },
    });
  });

  it('reports an unfinished call as running, and a failed one as error', () => {
    const running = projectMessage(message('assistant'), [tool({ status: 'running', input: { a: 1 }, time: { start: 5 } })], context);
    expect(running.content?.[0]).toMatchObject({ state: { status: 'running', input: { a: 1 } } });

    const failed = projectMessage(message('assistant'), [tool({ status: 'error', input: {}, output: 'boom', time: { start: 5, end: 6 } })], context);
    expect(failed.content?.[0]).toMatchObject({ state: { status: 'error', error: { message: 'boom' } } });
  });

  it('names a tool by its program name, not its title', () => {
    // The client picks the row component by `name` (`write`, `shell`, `read`) and
    // treats anything else as a generic card. Sending the human title
    // ("Write /path/to/file") made every write/edit row fall through to that generic
    // card, which has no error treatment — a failed call kept its activity spinner.
    const write: ToolPart = {
      ...tool({ status: 'completed', input: { file_path: '/tmp/a.py' }, output: 'ok', time: { start: 1, end: 2 } }),
      tool: 'write',
      state: { status: 'completed', input: {}, output: 'ok', title: 'Write /tmp/a.py', time: { start: 1, end: 2 } },
    };
    const projected = projectMessage(message('assistant'), [write], context);
    expect((projected.content?.[0] as { name?: string }).name).toBe('write');
  });

  it('paints the failure sentence of a failed tool, not the output it produced', () => {
    // A failed `write` "produces" the whole file as output. Using that as
    // `error.message` made a reopened transcript show a successful card whose error
    // was the file's content; the agent's own sentence is what belongs there.
    const failed: ToolPart = {
      ...tool({ status: 'error', time: { start: 1, end: 2 } }),
      tool: 'write',
      state: {
        status: 'error',
        input: { file_path: '/tmp/a.py' },
        output: '#!/usr/bin/env python3\nprint(1)\n',
        error: '[tool error: FS_STALE_VERSION]',
        time: { start: 1, end: 2 },
      },
    };
    const entry = projectMessage(message('assistant'), [failed], context).content?.[0] as {
      state: { status: string; error: { message: string }; content?: Array<{ text: string }> };
    };
    expect(entry.state.status).toBe('error');
    expect(entry.state.error.message).toBe('[tool error: FS_STALE_VERSION]');
    // The file's content may stay as the tool's own output, but the message the
    // client paints as the failure must not be it.
    expect(entry.state.error.message).not.toContain('print(1)');
  });

  it('uses the streaming state for a tool whose input is still a bare string', () => {
    const projected = projectMessage(message('assistant'), [tool({ status: 'running', input: 'partial', time: { start: 1 } })], context);
    expect(projected.content?.[0]).toMatchObject({ state: { status: 'streaming', input: 'partial' } });
  });

  it('keeps `parts` as the documented superset, for our own readers', () => {
    const parts = [text('hi')];
    const projected = projectMessage(message('assistant'), parts, context);
    expect(projected.parts).toEqual(parts);
  });

  it('carries a failed turn as an error beside the spec fields', () => {
    const projected = projectMessage(
      message('assistant', { error: { name: 'AcpError', message: 'agent died' } }),
      [],
      context,
    );
    expect(projected.error).toEqual({ type: 'AcpError', message: 'agent died' });
  });

  it('is well formed with no model selected yet', () => {
    const projected = projectMessage(message('assistant'), [], { agent: 'fake-acp' });
    expect(projected.model).toEqual({ id: 'unknown', providerID: 'fake-acp' });
    expect(projected.content).toEqual([]);
  });

  // ★ A turn that ended normally still has to say HOW it ended. `finish` used to be written
  // only when there was an error, so a completed row carried `finish: undefined` — and the
  // client kept its spinner up after the answer had finished streaming. Measured on a real
  // resumed (`-c`) session: the assistant row was `completed: true, finish: null`,
  // `/api/session/active` was already empty, and two Esc presses answered
  // `{interrupted:false}` because nothing was running. The screen disagreed with all three.
  it('records how a turn ended, not only when it ended badly', () => {
    const ok = projectMessage(message('assistant'), [text('done')], context);
    expect(ok.finish).toBe('stop');

    const failed = projectMessage(
      message('assistant', { error: { name: 'AcpError', message: 'agent died' } }),
      [],
      context,
    );
    expect(failed.finish).toBe('error');
  });
});
