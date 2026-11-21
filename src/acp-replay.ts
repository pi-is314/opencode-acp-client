/**
 * Turn a `session/load` replay into the same `HistoryEntry[]` the disk reader
 * produces, so the transcript renders through exactly the same path.
 *
 * A replay is a bare stream of `session/update`s: no turn or step framing, and
 * `user_message_chunk` is the only boundary between turns. `AcpTranslator` is
 * built the other way round - it opens an assistant message on `turn/start` and
 * reads its boundaries from there - and feeding it a replay collapsed 2687
 * updates into a single malformed message. Accumulating into history entries
 * instead reuses the shape the client already renders, and leaves the live path
 * untouched.
 */
import type { SessionUpdate } from './acp/types.js';

/** A tool call inside an assistant turn. */
export interface HistoryTool {
  callId: string;
  name: string;
  input: unknown;
  output?: string;
  completed: boolean;
  created: number;
}

/** The ordered view of a turn's content. */
export type HistoryPart =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }
  | {
      kind: 'tool';
      callId: string;
      name: string;
      input: unknown;
      completed: boolean;
      output?: string;
      created: number;
    };

/**
 * One turn of a conversation, in the shape the client renders.
 *
 * This shape used to come from a backend-specific history reader. It outlived
 * that reader because a `session/load` replay builds the same thing, and the
 * client renders both through one path.
 */
export interface HistoryEntry {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  created: number;
  model?: { providerID: string; modelID: string };
  tools?: HistoryTool[];
  parts?: HistoryPart[];
}


/** The text of a chunk, in every shape ACP sends it. */
export function chunkText(update: SessionUpdate): string {
  const content = update['content'];
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object' && !Array.isArray(content)) {
    const block = content as { type?: string; text?: string };
    if (typeof block.text === 'string') return block.text;
  }
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        const b = block as { type?: string; text?: string };
        return b.type === 'text' && typeof b.text === 'string' ? b.text : '';
      })
      .join('');
  }
  if (typeof update['text'] === 'string') return update['text'];
  return '';
}

/** A tool result arrives as content blocks; keep their text. */
function toolOutput(update: SessionUpdate): string | undefined {
  const content = update['content'];
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((block) => {
      const b = block as { type?: string; text?: string };
      return typeof b.text === 'string' ? b.text : '';
    })
    .join('');
  return text || undefined;
}

export function historyFromReplay(updates: readonly SessionUpdate[]): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  let seq = 0;
  let current: HistoryEntry | undefined;

  /** ACP message id -> the entry it owns. See `entryForChunk`. */
  const messageIds = new Map<string, HistoryEntry>();

  const openEntry = (role: 'user' | 'assistant', created: number): HistoryEntry => {
    const entry: HistoryEntry = {
      id: `rep_${role === 'user' ? 'u' : 'a'}_${seq++}`,
      role,
      text: '',
      created,
      ...(role === 'assistant' ? { parts: [] as HistoryPart[] } : {}),
    };
    entries.push(entry);
    current = entry;
    return entry;
  };

  /**
   * The entry a chunk belongs to.
   *
   * ACP lets the agent tag message chunks with an opaque `messageId`: chunks
   * sharing one are a single message, and a changed id starts a new one (spec,
   * "Message IDs"). Several agents never send it, so when it is absent we keep
   * the positional heuristic this function has always used — in a replay a
   * user message arrives as a consecutive run of chunks, and the first agent
   * chunk after them closes it.
   */
  const entryForChunk = (
    update: SessionUpdate,
    role: 'user' | 'assistant',
    created: number,
  ): HistoryEntry => {
    const raw = update['messageId'];
    const messageId = typeof raw === 'string' && raw ? raw : undefined;

    if (!messageId) {
      if (role === 'user') {
        const last = entries[entries.length - 1];
        return last?.role === 'user' ? last : openEntry('user', created);
      }
      return current?.role === 'assistant' ? current : openEntry('assistant', created);
    }

    const known = messageIds.get(messageId);
    // A reused id with a different role is malformed input, not a merge.
    if (known && known.role === role) {
      current = known;
      return known;
    }
    const entry = openEntry(role, created);
    messageIds.set(messageId, entry);
    return entry;
  };

  const assistantFor = (created: number): HistoryEntry =>
    current?.role === 'assistant' ? current : openEntry('assistant', created);

  const findTool = (callId: string): HistoryTool | undefined => {
    for (const entry of entries) {
      const hit = entry.tools?.find((tool) => tool.callId === callId);
      if (hit) return hit;
    }
    return undefined;
  };

  for (const update of updates) {
    const now = Date.now();
    switch (update.sessionUpdate) {
      case 'user_message_chunk': {
        const text = chunkText(update);
        if (!text) break;
        entryForChunk(update, 'user', now).text += text;
        break;
      }
      case 'agent_message_chunk': {
        const text = chunkText(update);
        if (!text) break;
        const entry = entryForChunk(update, 'assistant', now);
        entry.text += text;
        entry.parts ??= [];
        const last = entry.parts[entry.parts.length - 1];
        if (last?.kind === 'text') last.text += text;
        else entry.parts.push({ kind: 'text', text });
        break;
      }
      case 'agent_thought_chunk': {
        const text = chunkText(update);
        if (!text) break;
        const entry = entryForChunk(update, 'assistant', now);
        entry.parts ??= [];
        const last = entry.parts[entry.parts.length - 1];
        if (last?.kind === 'reasoning') last.text += text;
        else entry.parts.push({ kind: 'reasoning', text });
        break;
      }
      case 'tool_call': {
        const callId = String(update['toolCallId'] ?? '');
        if (!callId) break;
        const entry = assistantFor(now);
        const name = String(update['title'] ?? update['kind'] ?? 'tool');
        const tool: HistoryTool = {
          callId,
          name,
          input: update['rawInput'],
          completed: false,
          created: now,
        };
        entry.tools ??= [];
        entry.tools.push(tool);
        entry.parts ??= [];
        if (!entry.parts.some((part) => part.kind === 'tool' && part.callId === callId)) {
          entry.parts.push({ kind: 'tool', ...tool });
        }
        break;
      }
      case 'tool_call_update': {
        const callId = String(update['toolCallId'] ?? '');
        if (!callId) break;
        const tool = findTool(callId);
        if (!tool) break;
        const output = toolOutput(update);
        if (output !== undefined) tool.output = output;
        if (update['status'] === 'completed' || update['status'] === 'failed') tool.completed = true;
        const title = update['title'];
        if (typeof title === 'string' && title) tool.name = title;
        // The ordered view carries its own copy of the tool.
        for (const entry of entries) {
          const part = entry.parts?.find(
            (p): p is Extract<HistoryPart, { kind: 'tool' }> => p.kind === 'tool' && p.callId === callId,
          );
          if (part) {
            part.completed = tool.completed;
            part.output = tool.output;
            part.name = tool.name;
          }
        }
        break;
      }
      default:
        // usage_update carries totals, not transcript content: the bridge fills
        // the context meter from the backend's own store. Anything else is
        // presentation the client does not need yet.
        break;
    }
  }

  return entries;
}
