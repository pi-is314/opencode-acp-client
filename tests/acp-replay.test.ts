/**
 * `historyFromReplay` turns a `session/load` replay into turns.
 *
 * The properties that matter are the ones the old disk reader gave us for free
 * and a bare update stream does not: user chunks are the only turn boundary, and
 * each of them opens a new assistant message rather than letting every chunk in
 * the replay pile into one.
 */
import { describe, expect, it } from 'vitest';
import { chunkText, historyFromReplay } from '../src/acp-replay.js';
import type { SessionUpdate } from '../src/acp/types.js';

const u = (sessionUpdate: string, extra: Record<string, unknown> = {}): SessionUpdate =>
  ({ sessionUpdate, ...extra }) as SessionUpdate;

describe('chunkText', () => {
  it('reads a bare string, a single block, and an array of blocks', () => {
    expect(chunkText(u('x', { content: 'hi' }))).toBe('hi');
    expect(chunkText(u('x', { content: { type: 'text', text: 'hi' } }))).toBe('hi');
    expect(chunkText(u('x', { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }))).toBe('ab');
  });
  it('falls back to a top-level text field', () => {
    expect(chunkText(u('x', { text: 'hi' }))).toBe('hi');
  });
});

describe('historyFromReplay', () => {
  it('splits turns on user chunks and opens an assistant message per turn', () => {
    const entries = historyFromReplay([
      u('user_message_chunk', { content: { type: 'text', text: 'one' } }),
      u('agent_message_chunk', { content: { type: 'text', text: 'a' } }),
      u('agent_message_chunk', { content: { type: 'text', text: 'b' } }),
      u('user_message_chunk', { content: { type: 'text', text: 'two' } }),
      u('agent_message_chunk', { content: { type: 'text', text: 'c' } }),
    ]);
    expect(entries.map((e) => [e.role, e.text])).toEqual([
      ['user', 'one'],
      ['assistant', 'ab'],
      ['user', 'two'],
      ['assistant', 'c'],
    ]);
  });

  it('merges consecutive user chunks into one message', () => {
    const entries = historyFromReplay([
      u('user_message_chunk', { content: { type: 'text', text: 'he' } }),
      u('user_message_chunk', { content: { type: 'text', text: 'llo' } }),
      u('agent_message_chunk', { content: { type: 'text', text: 'hi' } }),
    ]);
    expect(entries.map((e) => [e.role, e.text])).toEqual([['user', 'hello'], ['assistant', 'hi']]);
  });

  it('keeps text, reasoning and tools in the order they arrived', () => {
    const entries = historyFromReplay([
      u('agent_message_chunk', { content: { type: 'text', text: 'thinking out loud' } }),
      u('agent_thought_chunk', { content: { type: 'text', text: 'hmm' } }),
      u('tool_call', { toolCallId: 'c1', title: 'bash', rawInput: { command: 'ls' } }),
      u('tool_call_update', { toolCallId: 'c1', status: 'completed', content: [{ type: 'text', text: 'ok' }] }),
      u('agent_message_chunk', { content: { type: 'text', text: 'done' } }),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0].parts?.map((p) => p.kind)).toEqual(['text', 'reasoning', 'tool', 'text']);
    expect(entries[0].tools?.[0]).toMatchObject({ callId: 'c1', completed: true, output: 'ok' });
  });

  it('starts a new assistant message when a turn has no user chunk before it', () => {
    const entries = historyFromReplay([
      u('agent_message_chunk', { content: { type: 'text', text: 'a' } }),
      u('user_message_chunk', { content: { type: 'text', text: 'q' } }),
      u('agent_message_chunk', { content: { type: 'text', text: 'b' } }),
    ]);
    expect(entries.map((e) => [e.role, e.text])).toEqual([['assistant', 'a'], ['user', 'q'], ['assistant', 'b']]);
  });

  it('ignores updates that carry no transcript content', () => {
    const entries = historyFromReplay([
      u('available_commands_update', {}),
      u('usage_update', { used: 10, size: 100 }),
      u('current_mode_update', {}),
    ]);
    expect(entries).toEqual([]);
  });
});

/**
 * "The Agent MAY include an opaque, unique `messageId` on message chunks. Chunks
 * with the same `messageId` belong to the same message; a changed `messageId`
 * indicates a new message." (ACP v1, Prompt Turn -> Message IDs)
 *
 * Read off the spec rather than inferred: the field name is `messageId`, and it
 * sits directly on the update next to `content`.
 */
describe('historyFromReplay and ACP message ids', () => {
  it('merges chunks that share a messageId — even when a tool call sits between them', () => {
    const entries = historyFromReplay([
      u('agent_message_chunk', { messageId: 'm1', content: { type: 'text', text: 'before' } }),
      u('tool_call', { toolCallId: 'c1', title: 'bash' }),
      u('tool_call_update', { toolCallId: 'c1', status: 'completed', content: [{ type: 'text', text: 'ok' }] }),
      u('agent_message_chunk', { messageId: 'm1', content: { type: 'text', text: 'after' } }),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe('beforeafter');
    // One text part per run, so the tool still sits between them in order.
    expect(entries[0].parts?.map((p) => p.kind)).toEqual(['text', 'tool', 'text']);
  });

  it('starts a new message as soon as the messageId changes', () => {
    const entries = historyFromReplay([
      u('agent_message_chunk', { messageId: 'm1', content: { type: 'text', text: 'first' } }),
      u('agent_message_chunk', { messageId: 'm2', content: { type: 'text', text: 'second' } }),
    ]);
    expect(entries.map((e) => [e.role, e.text])).toEqual([
      ['assistant', 'first'],
      ['assistant', 'second'],
    ]);
  });

  it('merges user chunks by id and splits them when the id changes', () => {
    const entries = historyFromReplay([
      u('user_message_chunk', { messageId: 'u1', content: { type: 'text', text: 'he' } }),
      u('user_message_chunk', { messageId: 'u1', content: { type: 'text', text: 'llo' } }),
      u('agent_message_chunk', { messageId: 'a1', content: { type: 'text', text: 'hi' } }),
      u('user_message_chunk', { messageId: 'u2', content: { type: 'text', text: 'again' } }),
      u('agent_message_chunk', { messageId: 'a2', content: { type: 'text', text: 'yes' } }),
    ]);
    expect(entries.map((e) => [e.role, e.text])).toEqual([
      ['user', 'hello'],
      ['assistant', 'hi'],
      ['user', 'again'],
      ['assistant', 'yes'],
    ]);
  });

  it('a tool call attaches to the assistant message that is currently open', () => {
    const entries = historyFromReplay([
      u('agent_message_chunk', { messageId: 'm1', content: { type: 'text', text: 'one' } }),
      u('agent_message_chunk', { messageId: 'm2', content: { type: 'text', text: 'two' } }),
      u('tool_call', { toolCallId: 'c9', title: 'grep' }),
    ]);
    expect(entries).toHaveLength(2);
    expect(entries[0].tools ?? []).toHaveLength(0);
    expect(entries[1].tools?.map((t) => t.callId)).toEqual(['c9']);
  });

  it('falls back to positional grouping when the agent sends no ids', () => {
    const entries = historyFromReplay([
      u('user_message_chunk', { content: { type: 'text', text: 'q' } }),
      u('agent_message_chunk', { content: { type: 'text', text: 'a' } }),
      u('agent_message_chunk', { content: { type: 'text', text: 'b' } }),
    ]);
    expect(entries.map((e) => [e.role, e.text])).toEqual([['user', 'q'], ['assistant', 'ab']]);
  });

  it('does not merge a reused id that belongs to the other role', () => {
    const entries = historyFromReplay([
      u('user_message_chunk', { messageId: 'same', content: { type: 'text', text: 'q' } }),
      // Malformed on the agent's part: the same id for an assistant message.
      u('agent_message_chunk', { messageId: 'same', content: { type: 'text', text: 'a' } }),
    ]);
    expect(entries.map((e) => [e.role, e.text])).toEqual([['user', 'q'], ['assistant', 'a']]);
  });
});
