import { describe, expect, it } from 'vitest';

import type { BridgeEvent, Location, ToolPart } from '../src/contract.js';
import { BridgeState } from '../src/state.js';
import { AcpTranslator } from '../src/translate/events.js';

/**
 * ACP updates, written as the raw JSON an agent actually puts on the wire.
 *
 * The object literals the rest of the suite uses cannot express the difference between a
 * field that is ABSENT and a field that is present and `null`, which ACP treats differently:
 * "omission and null are equivalent" is stated only for `rawInput`/`rawOutput`, while an
 * update otherwise carries "only the fields being changed". Zed models the distinction
 * explicitly (`MaybeUndefined::{Undefined, Null, Value}` in `acp/terminal_updates.rs`,
 * pinned by its `patch_preserves_omission_and_null` test); this suite does the same with
 * JSON text, the way an agent would send it.
 */
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
  const translator = new AcpTranslator(state, sink, LOCATION, () => {});
  const record = state.createSession(LOCATION);
  translator.beginTurn(record);
  /** Feed one `session/update` exactly as an agent would send it. */
  const send = (json: string) =>
    translator.apply(record, JSON.parse(json) as Parameters<AcpTranslator['apply']>[1]);
  const tool = (id: string): ToolPart | undefined => {
    const part = state.findPart(record, id);
    return part?.type === 'tool' ? part : undefined;
  };
  return { state, record, events, send, tool, translator };
}

describe('a tool update written as raw JSON', () => {
  it('leaves the status alone when the key is absent', () => {
    const h = harness();
    h.send(`{"sessionUpdate":"tool_call","toolCallId":"c1","title":"bash","kind":"execute","status":"in_progress","rawInput":{"command":"ls"}}`);
    const started = h.events.find((event) => event.type === 'session.tool.input.started')!;
    const partId = (started.data as { id: string }).id;
    expect(h.tool(partId)?.state.status).toBe('running');

    // Same call, new input, NO status key: the state must survive.
    h.send(`{"sessionUpdate":"tool_call_update","toolCallId":"c1","rawInput":{"command":"ls -la"}}`);
    expect(h.tool(partId)?.state.status).toBe('running');
    expect(h.tool(partId)?.state.input).toMatchObject({ command: 'ls -la' });
  });

  it('treats an explicit null as a value, not as absence', () => {
    const h = harness();
    h.send(`{"sessionUpdate":"tool_call","toolCallId":"c1","title":"bash","kind":"execute","status":"in_progress","rawInput":{"command":"ls"}}`);
    const started = h.events.find((event) => event.type === 'session.tool.input.started')!;
    const partId = (started.data as { id: string }).id;
    expect(h.tool(partId)?.state.status).toBe('running');

    // `status: null` is PRESENT, so it is not "unchanged" — it falls to the default,
    // which ACP states for a tool call that names no status: pending.
    h.send(`{"sessionUpdate":"tool_call_update","toolCallId":"c1","status":null}`);
    expect(h.tool(partId)?.state.status).toBe('pending');
  });

  it('defaults an initial call with no status to pending, as ACP states', () => {
    const h = harness();
    h.send(`{"sessionUpdate":"tool_call","toolCallId":"c2","title":"bash","kind":"execute","rawInput":{"command":"pwd"}}`);
    const started = h.events.find((event) => event.type === 'session.tool.input.started')!;
    const partId = (started.data as { id: string }).id;
    expect(h.tool(partId)?.state.status).toBe('pending');
  });
});

describe('the model value an agent advertises', () => {
  // dsh's ACP profile advertises its model option as `provider::model`. The
  // bridge only understood `provider/model` and the `["provider","model"]` array, so it
  // could not tell that a re-posted selection was already active: the selection reached
  // the agent, which refuses a switch mid-prompt, and the TUI retried the 400 instead of
  // sending the next message (owner's "queueing a second message does nothing").
  it('reads the double-colon form as provider :: model', async () => {
    const { modelValueParts } = await import('../src/server.js');
    expect(modelValueParts('acme::model-1')).toEqual({
      providerID: 'acme',
      modelID: 'model-1',
    });
  });

  it('still reads the slash form and the array form', async () => {
    const { modelValueParts } = await import('../src/server.js');
    expect(modelValueParts('openai/gpt-4')).toEqual({ providerID: 'openai', modelID: 'gpt-4' });
    expect(modelValueParts('["openai","gpt-4"]')).toEqual({ providerID: 'openai', modelID: 'gpt-4' });
    expect(modelValueParts('bare-model')).toEqual({ modelID: 'bare-model' });
  });
});
