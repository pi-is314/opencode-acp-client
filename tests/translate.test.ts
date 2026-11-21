import { describe, expect, it } from 'vitest';

import type { BridgeEvent, Location, ToolPart } from '../src/contract.js';
import { projectMessage } from '../src/project.js';
import { BridgeState } from '../src/state.js';
import { AcpTranslator, mapToolStatus, toolOutput, withClientInputKey } from '../src/translate/events.js';

const LOCATION: Location = {
  directory: '/tmp/work',
  project: { id: 'p', directory: '/tmp/work', canonical: '/tmp/work' },
};

function harness() {
  const state = new BridgeState();
  const events: BridgeEvent[] = [];
  const sink = {
    emit(event: Omit<BridgeEvent, 'id'>) {
      const framed = { ...event, id: `e${events.length}` } as BridgeEvent;
      events.push(framed);
      return framed;
    },
  };
  const logs: string[] = [];
  const translator = new AcpTranslator(state, sink, LOCATION, (line) => logs.push(line));
  const record = state.createSession(LOCATION);
  return { state, events, translator, record, logs, types: () => events.map((e) => e.type) };
}

describe('AcpTranslator', () => {
  it('learns the agent name when the translator was created before the agent', () => {
    // A turn that could not start renders its failure through a translator that has
    // no agent yet, so it reports the `acp` placeholder. Before a retry succeeds the
    // real name must replace it, or every later row's footer keeps saying `acp`.
    const { translator, record, events } = harness();
    translator.setAgentName('real-agent');
    translator.beginTurn(record);
    // No assistant row until the first part: emitting step.started at prompt
    // acceptance is what painted the extra blank line before the reply.
    expect(events.some((event) => event.type === 'session.step.started')).toBe(false);
    translator.apply(record, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } });
    const started = events.find((event) => event.type === 'session.step.started');
    expect((started?.data as { agent?: string } | undefined)?.agent).toBe('real-agent');
    // v2.0.32's `Step.Started` carries the dispatch time as `started`; the client
    // tolerates its absence, but the schema declares it, so we send it.
    expect(typeof (started?.data as { started?: unknown } | undefined)?.started).toBe('number');
    // The placeholder and `unknown` are not names: they must not overwrite a real
    // one, so the NEXT turn's row still carries the agent's own name.
    translator.setAgentName('acp');
    translator.setAgentName('unknown');
    events.length = 0;
    translator.beginTurn(record);
    translator.apply(record, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'again' } });
    const again = events.find((event) => event.type === 'session.step.started');
    expect((again?.data as { agent?: string } | undefined)?.agent).toBe('real-agent');
  });

  it('ends each text block with its own text, not the first block of the turn', () => {
    // Measured on the owner's live session: intro text, two tools, summary text. The turn-end
    // path emitted one `session.text.ended` carrying the *first* text part, while the shipped
    // client applies that event to the *last* text entry — so the summary was overwritten with
    // the intro and the screen showed the intro twice. Each `ended` must carry the text of the
    // block it closes.
    const { translator, record, events, state } = harness();
    const messageId = translator.beginTurn(record);
    translator.apply(record, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'intro text' },
    });
    translator.apply(record, {
      sessionUpdate: 'tool_call',
      toolCallId: 'call-x',
      title: 'echo',
      kind: 'other',
      status: 'in_progress',
      rawInput: {},
    });
    translator.apply(record, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-x',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'tool output' } }],
    });
    translator.apply(record, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'summary text' },
    });
    translator.endTurn(record);

    const ended = events.filter((e) => e.type === 'session.text.ended');
    expect(ended.map((e) => (e.data as { text?: string }).text)).toEqual(['intro text', 'summary text']);
    // And the stored transcript keeps both blocks in order.
    const texts = state
      .partsOf(record, messageId)
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map((part) => part.text);
    expect(texts).toEqual(['intro text', 'summary text']);
  });

  it('always names a model on step.started, even before the agent reports one', () => {
    // The shipped client inserts the assistant row from this event and dereferences
    // `message.model.providerID` without a guard, so `model: undefined` crashes the TUI rather
    // than merely omitting a label. The schema makes the field optional; v2.0.28 does not honour
    // that here. Until the agent reports a model, name the placeholder.
    const { translator, record, events } = harness();
    translator.beginTurn(record);
    translator.apply(record, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'one' } });
    const step = events.find((e) => e.type === 'session.step.started');
    expect(step?.data).toMatchObject({ model: { id: 'unknown', providerID: 'acp' } });

    // Once the session knows its model, that is what the row must carry instead.
    record.model = { providerID: 'fake', modelID: 'model-1' };
    translator.beginTurn(record);
    translator.apply(record, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'two' } });
    const next = [...events].reverse().find((e) => e.type === 'session.step.started');
    expect(next?.data).toMatchObject({ model: { id: 'model-1', providerID: 'fake' } });
  });

  it('turns an agent message chunk into a delta plus a part update', () => {
    const { translator, record, events, types } = harness();
    translator.beginTurn(record);
    translator.apply(record, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'hello' },
    });
    expect(types()).toContain('message.part.updated');
    // First sighting of a part emits only `updated`; the TUI creates from it.
    expect(types().filter((t) => t === 'message.part.delta')).toHaveLength(0);

    translator.apply(record, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: ' world' },
    });
    const delta = events.find((e) => e.type === 'message.part.delta');
    expect(delta?.data).toMatchObject({ delta: ' world', field: 'text' });
  });

  it('accumulates text into one part rather than many', () => {
    const { translator, record, state } = harness();
    const messageId = translator.beginTurn(record);
    for (const text of ['a', 'b', 'c']) {
      translator.apply(record, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
    }
    const parts = state.partsOf(record, messageId);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ type: 'text', text: 'abc' });
  });

  it('maps a thought chunk to a reasoning part', () => {
    const { translator, record, state } = harness();
    const messageId = translator.beginTurn(record);
    translator.apply(record, {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'hmm' },
    });
    expect(state.partsOf(record, messageId)[0]).toMatchObject({ type: 'reasoning', text: 'hmm' });
  });

  it('ignores user chunks because the prompt already rendered the bubble', () => {
    const { translator, record, events } = harness();
    translator.beginTurn(record);
    const before = events.length;
    translator.apply(record, {
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'echo' },
    });
    expect(events.length).toBe(before);
  });

  it('logs a plan update and emits nothing, because v2 has no todo surface', () => {
    // opencode v2 removed todo entirely (PR #35989: tool, sidebar panel, events
    // and the persisted table, no replacement named). An event nothing renders
    // would look like a working feature, so the entries are logged instead.
    const { translator, record, state, logs, types } = harness();
    const messageId = translator.beginTurn(record);
    translator.apply(record, {
      sessionUpdate: 'plan',
      entries: [{ content: 'a', status: 'pending' }],
    });
    expect(types()).not.toContain('todo.updated');
    // No part is created at all: v2 has no renderer for one.
    expect(state.partsOf(record, messageId)).toHaveLength(0);
    expect(logs.join('\n')).toContain('has no opencode v2 surface');
    expect(logs.join('\n')).toContain('pending:a');
  });

  it('keeps one tool part per toolCallId across updates', () => {
    const { translator, record, state } = harness();
    const messageId = translator.beginTurn(record);
    translator.apply(record, {
      sessionUpdate: 'tool_call',
      toolCallId: 'c1',
      title: 'bash',
      status: 'in_progress',
      rawInput: { cmd: 'ls' },
    });
    translator.apply(record, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'c1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'out' } }],
    });
    const tools = state.partsOf(record, messageId).filter((p) => p.type === 'tool');
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ callID: 'c1', state: { status: 'completed', output: 'out' } });
  });

  it('closes an open reasoning part when the turn ends', () => {
    const { translator, record, state, events } = harness();
    const messageId = translator.beginTurn(record);
    translator.apply(record, {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'thinking' },
    });
    translator.endTurn(record);
    const part = state.partsOf(record, messageId)[0];
    expect(part?.type).toBe('reasoning');
    expect((part as { time: { end?: number } }).time.end).toBeTypeOf('number');
    // turn.wait / turn.idle bracket the turn.
    expect(events.map((e) => e.type)).toContain('turn.wait');
    expect(events.map((e) => e.type)).toContain('turn.idle');
  });

  it('ends a cancelled turn as interrupted, never as succeeded', () => {
    const { translator, record, events } = harness();
    translator.beginTurn(record);
    translator.endTurn(record, { interrupted: true });
    const types = events.map((e) => e.type);
    expect(types).toContain('session.execution.interrupted');
    // The client maps a success to `outcome: "succeeded"`, which is a lie for a
    // turn the user cancelled.
    expect(types).not.toContain('session.execution.succeeded');
    expect(types).not.toContain('session.execution.failed');
  });

  it('records an error on the assistant message when the turn fails', () => {
    const { translator, record, state } = harness();
    const messageId = translator.beginTurn(record);
    translator.endTurn(record, { error: 'boom' });
    expect(state.getMessage(record, messageId)?.error?.message).toBe('boom');
  });

  it('logs unknown updates instead of silently dropping them', () => {
    const logs: string[] = [];
    const state = new BridgeState();
    const record = state.createSession(LOCATION);
    const translator = new AcpTranslator(
      state,
      { emit: (e) => ({ ...e, id: 'x' }) },
      LOCATION,
      (line) => logs.push(line),
    );
    translator.beginTurn(record);
    translator.apply(record, { sessionUpdate: 'something_new_entirely' });
    expect(logs.some((l) => l.includes('something_new_entirely'))).toBe(true);
  });
});

describe('mapToolStatus', () => {
  it('never reports an unknown status as completed', () => {
    // ACP: a `tool_call`'s status "defaults to `pending`", so an absent one is pending, not
    // running — the old default turned a tool that never started into a spinner. An
    // unrecognised string is not a terminal state either.
    expect(mapToolStatus(undefined)).toBe('pending');
    expect(mapToolStatus('weird')).toBe('pending');
    expect(mapToolStatus('completed')).toBe('completed');
  });

  it('maps the shapes agents actually send', () => {
    expect(mapToolStatus('completed')).toBe('completed');
    expect(mapToolStatus('failed')).toBe('error');
    expect(mapToolStatus('pending')).toBe('pending');
  });
});

describe('toolOutput', () => {
  it('reads a string rawOutput', () => {
    expect(toolOutput({ sessionUpdate: 'tool_call', rawOutput: 'done' })).toBe('done');
  });

  it('reads nested ACP content blocks', () => {
    expect(
      toolOutput({
        sessionUpdate: 'tool_call_update',
        content: [{ type: 'content', content: { type: 'text', text: 'hi' } }],
      }),
    ).toBe('hi');
  });
});

/**
 * ACP: "The Client **SHOULD** preemptively mark all non-finished tool calls
 * pertaining to the current turn as `cancelled` as soon as it sends the
 * `session/cancel` notification."
 *
 * opencode has no `cancelled` tool state, so the contract is met with the
 * terminal state it does have. What must not happen is a row left `running`: the
 * aborted turn will never send the update that would close it.
 */
describe('cancelling an aborted turn', () => {
  it('closes tool calls that have not finished', () => {
    const { translator, record, state, events, types } = harness();
    translator.beginTurn(record);
    translator.apply(record, { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'bash', status: 'in_progress' });
    translator.apply(record, { sessionUpdate: 'tool_call', toolCallId: 'c2', title: 'grep', status: 'pending' });

    const messageId = state.getMessage(record, record.messages[record.messages.length - 1]!.id)!.id;
    expect(translator.closeOpenToolCalls(record, 'cancelled: the turn was aborted before this tool finished')).toBe(2);
    expect(
      state.partsOf(record, messageId).map((part) => (part.type === 'tool' ? part.state.status : 'other')),
    ).toEqual(['error', 'error']);
    expect(types().filter((t) => t === 'session.tool.failed')).toHaveLength(2);
    expect(events.some((e) => JSON.stringify(e.data).includes('the turn was aborted'))).toBe(true);
  });

  it('leaves finished tool calls alone', () => {
    const { translator, record, state } = harness();
    translator.beginTurn(record);
    translator.apply(record, { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'bash' });
    translator.apply(record, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'c1',
      status: 'completed',
      content: [{ type: 'text', text: 'ok' }],
    });

    expect(translator.closeOpenToolCalls(record, 'cancelled: the turn was aborted before this tool finished')).toBe(0);
    const messageId = record.messages[record.messages.length - 1]!.id;
    expect(state.partsOf(record, messageId)[0]).toMatchObject({ state: { status: 'completed', output: 'ok' } });
  });

  it('treats an agent-sent cancelled status as terminal, not as a spinner', () => {
    expect(mapToolStatus('cancelled')).toBe('error');
    expect(mapToolStatus('canceled')).toBe('error');
  });
});

/**
 * ACP reserves `_meta` for extensions: a client must not clobber an agent's keys,
 * and it must not simply drop them either. opencode's HTTP schemas have no field
 * for it, so it lives on the session record.
 */
describe('_meta', () => {
  it('is kept on the session and merged across updates', () => {
    const { translator, record } = harness();
    translator.apply(record, {
      sessionUpdate: 'usage_update',
      used: 1,
      size: 10,
      _meta: { 'acme/one': 1 },
    });
    expect(record.meta).toEqual({ 'acme/one': 1 });

    translator.apply(record, {
      sessionUpdate: 'usage_update',
      used: 2,
      size: 10,
      _meta: { 'acme/two': 2 },
    });
    // The earlier key survives: merging, not replacing.
    expect(record.meta).toEqual({ 'acme/one': 1, 'acme/two': 2 });
  });

  it('leaves the session alone when there is no _meta, and ignores a non-object', () => {
    const { translator, record } = harness();
    translator.apply(record, { sessionUpdate: 'usage_update', used: 1, size: 10 });
    expect(record.meta).toBeUndefined();
    translator.apply(record, { sessionUpdate: 'usage_update', used: 1, size: 10, _meta: 'nope' });
    expect(record.meta).toBeUndefined();
  });
});

describe('a tool whose first frame carries no input', () => {
  it('reports an empty record, never null, so the client cannot crash', () => {
    // Measured on the real TUI: the first `tool_call` of a dsh turn can arrive with
    // no `rawInput` at all. The client stores `running` inputs as a record and runs
    // `Object.entries` over it, so `input: undefined` took the whole TUI down with
    // "Object.entries requires that input parameter not be null or undefined".
    const { translator, record, events } = harness();
    translator.beginTurn(record);
    translator.apply(record, { sessionUpdate: 'tool_call', toolCallId: 'c-none', title: 'bash all commands' });

    const called = events.find((event) => event.type === 'session.tool.called');
    expect((called?.data as { input?: unknown } | undefined)?.input).toEqual({});
  });

  it('prefers the programmatic name over the human title', () => {
    // ACP: `name` is the tool's program name, `title` is prose for humans. The client
    // picks its row component by this value, so the title made a shell row render as
    // an unknown tool ("Writing command…").
    const { translator, record, events } = harness();
    translator.beginTurn(record);
    translator.apply(record, {
      sessionUpdate: 'tool_call',
      toolCallId: 'c-named',
      name: 'bash',
      title: 'bash all commands',
      kind: 'execute',
      status: 'in_progress',
      rawInput: { command: 'ls' },
    });
    const started = events.find((event) => event.type === 'session.tool.input.started');
    expect((started?.data as { name?: string } | undefined)?.name).toBe('bash');
  });
});

describe('a title that arrives after the first frame', () => {
  it('lets the later, real caption replace the generic one', () => {
    // dsh sends `title: "bash all commands"` with the pending frame and the real
    // command only with in_progress. Keeping the FIRST title froze the generic
    // caption into the row and into the reloaded projection.
    const { translator, record, state } = harness();
    translator.beginTurn(record);
    translator.apply(record, {
      sessionUpdate: 'tool_call',
      toolCallId: 'c-title',
      title: 'bash all commands',
      kind: 'other',
      status: 'pending',
      rawInput: { command: 'ls -la' },
    });
    translator.apply(record, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'c-title',
      status: 'in_progress',
      title: 'ls -la',
    });

    const messageId = record.messages[record.messages.length - 1]!.id;
    const part = state.partsOf(record, messageId).find((item) => item.type === 'tool');
    expect(part).toMatchObject({ type: 'tool', state: { title: 'ls -la' } });
  });
});

describe('the ACP tool kind', () => {
  it('is recorded on the part, so a projection can present the row correctly', () => {
    // ACP's `kind` is what tells a client how to present a call ("execute" → a command).
    // It must survive into our part, not just ride the event: a reloaded transcript is
    // rebuilt from these parts.
    const { translator, record, state } = harness();
    translator.beginTurn(record);
    translator.apply(record, {
      sessionUpdate: 'tool_call',
      toolCallId: 'c-kind',
      name: 'bash',
      kind: 'execute',
      title: 'ls -la',
      status: 'pending',
      rawInput: { command: 'ls -la' },
    });

    const messageId = record.messages[record.messages.length - 1]!.id;
    const part = state.partsOf(record, messageId).find((item) => item.type === 'tool');
    expect(part).toMatchObject({ type: 'tool', tool: 'bash', state: { kind: 'execute' } });
  });

  it('projects an execute-kind call with no program name as a shell row', () => {
    // dsh names nothing but a title; `kind: "execute"` is then the only signal that this
    // is a command. Without it the client renders a generic card it cannot expand.
    const part: ToolPart = {
      id: 'prt_k1', sessionID: 'ses_1', messageID: 'msg_a1', type: 'tool',
      callID: 'call-k', tool: 'tool',
      state: { status: 'completed', input: {}, output: 'ok', kind: 'execute', time: { start: 1, end: 2 } },
    };
    const projected = projectMessage(
      { id: 'msg_a1', sessionID: 'ses_1', role: 'assistant', time: { created: 1, completed: 2 } },
      [part],
      { agent: 'fake-acp' },
    );
    expect((projected.content?.[0] as { name?: string }).name).toBe('shell');
  });
});

describe('the input key the client renders from', () => {
  // ACP declares `rawInput` as "any JSON value" and gives `kind` as the display category,
  // while opencode's TUI renders a read/edit row from `input.path` and a shell row from
  // `input.command`. An agent that follows the spec with `{file_path}` therefore showed an
  // empty "Preparing edit…" row (measured on v2.2.0), so the kind adds the key it reads.
  it('adds input.path for a read/edit whose path lives under another key', () => {
    expect(withClientInputKey({ file_path: '/tmp/a.py' }, 'edit', 'edit')).toMatchObject({
      file_path: '/tmp/a.py',
      path: '/tmp/a.py',
    });
    expect(withClientInputKey({ filePath: '/tmp/b.py' }, 'read', 'read')).toMatchObject({ path: '/tmp/b.py' });
  });

  it('never overwrites a path the agent already sent', () => {
    expect(withClientInputKey({ path: '/real.py', file_path: '/other.py' }, 'edit', 'edit')).toEqual({
      path: '/real.py',
      file_path: '/other.py',
    });
  });

  it('adds input.command for an execute call', () => {
    expect(withClientInputKey({ cmd: 'ls -la' }, 'execute', 'bash')).toMatchObject({ command: 'ls -la' });
  });

  it('leaves an input alone when the kind says nothing', () => {
    expect(withClientInputKey({ file_path: '/tmp/a.py' }, 'other', 'read-ish')).toEqual({ file_path: '/tmp/a.py' });
    expect(withClientInputKey('a string', 'read', 'read')).toBe('a string');
  });
});

describe('a command that is still streaming in', () => {
  // Measured with `dsh --profile <profile>`: the first tool_call for a bash tool carried
  // `rawInput: {arguments: '{"'}` and completed on the next update. Taking the first string
  // put `{"` on screen as the command (the owner's `$ {`), so an unfinished JSON fragment
  // must not become `input.command`.
  it('does not promote an unfinished JSON fragment to input.command', () => {
    expect(withClientInputKey({ arguments: '{"' }, 'execute', 'bash')).toEqual({ arguments: '{"' });
    expect(withClientInputKey({ arguments: '{"command":"ls"}' }, 'execute', 'bash')).toEqual({
      arguments: '{"command":"ls"}',
    });
  });

  it('still promotes a real command', () => {
    expect(withClientInputKey({ command: 'ls -la' }, 'execute', 'bash')).toMatchObject({ command: 'ls -la' });
    expect(withClientInputKey({ cmd: 'echo hi' }, 'execute', 'bash')).toMatchObject({ command: 'echo hi' });
  });
});

describe('a frame that changes the input but not the status', () => {
  // `dsh --profile <profile>` streams a tool's arguments character by character and then
  // sends the completed `rawInput` in a frame with NO `status`. The translator keeps the
  // state it already has for such a frame (see `applyToolCallUpdate`), and `mapToolStatus`
  // itself only ever sees a real value — this pins the part that is pure.
  it('maps every status ACP defines, and treats cancelled as terminal', () => {
    expect(mapToolStatus('pending')).toBe('pending');
    expect(mapToolStatus('in_progress')).toBe('running');
    expect(mapToolStatus('completed')).toBe('completed');
    expect(mapToolStatus('failed')).toBe('error');
    expect(mapToolStatus('cancelled')).toBe('error');
  });
});

describe('the terminal output a client has agreed to read', () => {
  // `CLIENT_CAPABILITIES._meta.terminal_output` announces this dialect (Zed announces the
  // same key) and agents branch on it: only the agreed form carries the
  // finished command text, the other sends deltas nothing here reassembles and leaves a
  // `{formatted_output, exit_code}` record in `rawOutput` — the JSON blob on the card.
  it('prefers the negotiated terminal output over the raw record', () => {
    expect(
      toolOutput({
        sessionUpdate: 'tool_call_update',
        _meta: { terminal_output: { data: 'hello\n', terminal_id: 'c1' } },
        rawOutput: { formatted_output: 'hello\n', exit_code: 0 },
      } as never),
    ).toBe('hello\n');
  });

  it('prefers content over rawOutput, the way Zed stops there once content exists', () => {
    // ACP defines `content` as the blocks shown to the user, and Zed's
    // `update_raw_output_content` returns early when any structured content exists.
    expect(
      toolOutput({
        sessionUpdate: 'tool_call_update',
        content: [{ type: 'content', content: { type: 'text', text: 'the real output' } }],
        rawOutput: { output: 'ignored', isError: false },
      } as never),
    ).toBe('the real output');
  });

  it('falls back to the delta dialect, then to rawOutput', () => {
    expect(
      toolOutput({
        sessionUpdate: 'tool_call_update',
        _meta: { terminal_output_delta: { data: 'from delta', terminal_id: 'c1' } },
        rawOutput: { formatted_output: 'ignored', exit_code: 0 },
      } as never),
    ).toBe('from delta');
    // A record is pretty-printed, as Zed's `raw_output_text` does: the TUI collapses the
    // card to a few rows, and one long line of JSON is unreadable in them.
    expect(
      toolOutput({ sessionUpdate: 'tool_call_update', rawOutput: { exit_code: 1 } } as never),
    ).toBe(JSON.stringify({ exit_code: 1 }, null, 2));
  });
});

describe('a delegated agent must be recognisable as one', () => {
  // opencode's TUI renders its dedicated Subagent row (a "Delegating…" label and a click
  // that opens the child) only for the tool name `task`; ACP's own `kind: "think"` or
  // `other` falls through to the generic card, so a user cannot tell a subagent from a
  // shell command. Measured across all three dsh ACP profiles, the word is the same and is
  // the agent's OWN tool name — `dsh --profile acp` sends no `name` and a `title` of
  // "subagent", one adapter sends `name: "subagent"`, and `opencode acp`
  // sends no `name` with its title falling back to `task`.
  const nameFor = (update: Record<string, unknown>, agentName?: string): string | undefined => {
    const { translator, record, events } = harness();
    if (agentName) translator.setAgentName(agentName);
    translator.beginTurn(record);
    translator.apply(record, { sessionUpdate: 'tool_call', toolCallId: 'c-sub', status: 'in_progress', ...update } as never);
    const started = events.find((event) => event.type === 'session.tool.input.started');
    return (started?.data as { name?: string } | undefined)?.name;
  };

  it('maps every spelling the agents actually send to the name the TUI renders a child for', () => {
    expect(nameFor({ name: 'subagent', kind: 'other' })).toBe('task');       // my-profile
    expect(nameFor({ title: 'subagent', kind: 'other' })).toBe('task');      // dsh --profile acp
    expect(nameFor({ title: 'task', kind: 'think' })).toBe('task');          // opencode acp
    // claude-agent-acp names the two tools its renderer treats as subagents.
    expect(nameFor({ name: 'Agent', kind: 'other' })).toBe('task');
    expect(nameFor({ name: 'Task', kind: 'other' })).toBe('task');
    // codex-acp verb-prefixes the activity instead of naming the tool.
    expect(nameFor({ title: 'Start subagent explorer', kind: 'other' }, '@agentclientprotocol/codex-acp')).toBe(
      'task',
    );
    expect(nameFor({ title: 'Interact with subagent explorer', kind: 'other' }, 'Codex')).toBe('task');
  });

  it('reads a subagent out of the TITLE only for codex', () => {
    // Everywhere else `title` is prose, so another adapter that writes "Start subagent …"
    // as a caption must keep its generic card. The gate is the name from `initialize`,
    // which survives npx, a local checkout path and a wrapper script.
    for (const other of ['DeepSeek Harness', 'Gemini CLI', 'Qwen Code', undefined]) {
      expect(nameFor({ name: 'exec_command', title: 'Start subagent explorer', kind: 'other' }, other)).toBe(
        'exec_command',
      );
    }
  });

  it('leaves tools that merely mention agents on the generic card', () => {
    // These are ACP tools an agent uses to manage its children, not a child itself.
    expect(nameFor({ name: 'list_agents', kind: 'other' })).toBe('list_agents');
    expect(nameFor({ name: 'send_message', kind: 'other' })).toBe('send_message');
    expect(nameFor({ name: 'job_list', kind: 'other' })).toBe('job_list');
    // Anchored: a longer tool name that contains the word is not a subagent.
    expect(nameFor({ name: 'subagent_manager', kind: 'other' })).toBe('subagent_manager');
    // A codex tool whose TITLE merely mentions a subagent is not one of its activity rows.
    expect(nameFor({ name: 'exec_command', title: 'grep subagent logs', kind: 'read' })).toBe('exec_command');
  });
});
