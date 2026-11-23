/**
 * The bridge's own transcript → opencode v2's typed messages.
 *
 * This is the *history* path. A live turn never comes through here: the client
 * paints it from the SSE events, whose vocabulary it does read. Everything it
 * learns by reading — `GET /api/session/:id/message` (and `/message/:id`) — is a
 * `Session.Message.Info`: one tagged object per message carrying its content
 * inline (`text` on a user turn, `content` on an assistant one). It does not
 * read our internal `{id, sessionID, role, time}` rows or their separate parts,
 * which is why a reload served in the old shape rendered an empty transcript
 * while live turns looked fine.
 *
 * So: `Message` + its `Part[]` in, spec shape out, in one place.
 *
 * Two deliberate deviations from the spec, both a *superset* (documented in
 * `scripts/check-openapi.py`'s ALLOWED table):
 *  - every message keeps `parts` (our own readers, `scripts/e2e-real-agent.sh`,
 *    read that) and the legacy `role`/`sessionID` mirror;
 *  - a tool state that the spec has no equivalent for is projected onto the
 *    nearest one it does (see `toolState`).
 */

import type { Message, Part, ToolPart } from './contract.js';

/**
 * What a message needs from its session to be projectable.
 *
 * `agent` is the backend's own name — the same id `/api/agent` advertises, not a
 * label we invent here.
 */
export interface ProjectionContext {
  agent: string;
  model?: { providerID: string; modelID: string };
}

/** A projected message: the spec's fields plus the superset described above. */
export interface ProjectedMessage {
  id: string;
  type: 'user' | 'assistant' | 'system';
  time: { created: number; completed?: number };
  /** `Session.Message.User`. */
  text?: string;
  /** `Session.Message.System` — the model-facing text and the display description. */
  description?: string;
  /** `Session.Message.Assistant`. */
  agent?: string;
  model?: { id: string; providerID: string };
  content?: Array<Record<string, unknown>>;
  error?: { type: string; message: string };
  /** The bridge's raw parts, kept for our own readers. */
  parts: Part[];
  role: 'user' | 'assistant';
  sessionID: string;
}

/** The spec pins every message id to this prefix (`Session.Message.ID`). */
const MESSAGE_ID = /^msg_/;

/**
 * Coerce an id onto the spec's `^msg_` pattern.
 *
 * Live ids already match. A replayed history id does not — and the client keys
 * rows by id, so anything that does not match the schema is a bug the spec
 * checker is right to flag.
 */
export function specMessageId(id: string): string {
  return MESSAGE_ID.test(id) ? id : `msg_${id}`;
}

/**
 * A tool state's `input` is an object in every state the spec defines except
 * `streaming`, whose input is the raw string. ACP hands us either.
 */
function inputObject(input: unknown): Record<string, unknown> {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return {};
}

/** `Tool.Content[]` for a finished call. The spec requires a non-empty array. */
function toolContent(output: string | undefined): Array<Record<string, unknown>> {
  return [{ type: 'text', text: output ?? '' }];
}

/**
 * Our tool status → the spec's `ToolState` union.
 *
 * The spec has four states and we have four statuses, but they are not the same
 * four: `pending` has no counterpart (a queued call is reported as `running`,
 * which is what it looks like in the UI anyway), and `streaming` — the only
 * state that carries a string input — is what a call whose input is a bare
 * string gets.
 */
function toolState(part: ToolPart): Record<string, unknown> {
  const { status, input, output } = part.state;
  // Carry the part's own metadata through. It used to be hard-coded to `{}`, which threw away
  // `metadata.shellID` — and the client's shell row reads exactly that to find the shell whose
  // output it fetches. A reloaded transcript therefore lost every `!command` card's output.
  const metadata = part.state.metadata ?? {};
  if (status === 'completed') {
    return {
      status: 'completed',
      input: inputObject(input),
      content: toolContent(output),
      metadata,
    };
  }
  if (status === 'error') {
    // The agent's failure sentence, NOT the tool's output: a failed `write` produces
    // the whole file as output, and painting that as `error.message` made the client
    // render a successful-looking card whose error was the file's content. Aborted
    // calls (`closeOpenToolCalls`) record their reason here too.
    const message = part.state.error ?? output ?? 'tool failed';
    return {
      status: 'error',
      input: inputObject(input),
      error: { type: 'tool', message },
      // A failed call's own output is separate from the failure; the client draws the
      // error card from `error`, so only carry content when the tool actually produced
      // something and it is not just a repeat of the failure sentence.
      ...(output === undefined || output === message ? {} : { content: toolContent(output) }),
      metadata,
    };
  }
  if (typeof input === 'string') return { status: 'streaming', input };
  return { status: 'running', input: inputObject(input), metadata };
}

/** One `Session.Message.Assistant.Tool`. */
function toolEntry(part: ToolPart): Record<string, unknown> {
  const { start, end } = part.state.time;
  return {
    type: 'tool',
    // The id the live events give this row, so a reloaded tool and a streaming
    // one are the same card.
    id: part.id,
    // The client picks the row component by `name` and expects the *program* name
    // (`write`, `shell`, …); `title` is its human-readable caption ("Write /path").
    // Sending the title here made every such row fall through to the generic card,
    // where a failed call never got its error treatment.
    name: part.state.kind === 'execute' && part.tool === 'tool' ? 'shell' : part.tool,
    // The client reads `metadata.shellID` off the part to find the shell behind a
    // `!command` card. It lives inside `state` in the published schema, so it has to be
    // projected here as well as sent with the live events.
    ...(part.state.metadata === undefined ? {} : { metadata: part.state.metadata }),
    // The bridge never parks a call before handing it to the agent.
    executed: true,
    state: toolState(part),
    time: { created: start, ran: start, ...(end === undefined ? {} : { completed: end }) },
  };
}

/** One entry of `Session.Message.Assistant.content`. */
function contentEntry(part: Part): Record<string, unknown> {
  if (part.type === 'text') return { type: 'text', text: part.text };
  if (part.type === 'reasoning') {
    return {
      type: 'reasoning',
      text: part.text,
      // `time` is required by our type, but a malformed part must not take the
      // whole transcript down with it.
      ...(part.time?.end === undefined
        ? {}
        : { time: { created: part.time.start, completed: part.time.end } }),
    };
  }
  return toolEntry(part);
}

/**
 * Project one message and its parts onto `Session.Message.Info`.
 *
 * The union member follows the message's own role, so a user turn is a
 * `Session.Message.User` (whose text is the concatenation of its text parts —
 * `text` is a required field and this is the only place it is recorded) and an
 * assistant turn is a `Session.Message.Assistant` whose `content` is the parts
 * in the order the agent produced them.
 */
export function projectMessage(
  message: Message,
  parts: readonly Part[],
  context: ProjectionContext,
): ProjectedMessage {
  const base = {
    id: specMessageId(message.id),
    // The legacy mirror, see the module comment.
    role: message.role,
    sessionID: message.sessionID,
    parts: [...parts] as Part[],
  };

  // A `!command` is its own message type in the published schema, and the TUI renders it by
  // matching `message.type === "shell"`. Projecting it as an assistant tool part instead — which
  // is what the bridge used to do — brought it back from history as a generic tool card with no
  // shell behind it, so its status and output were wrong.
  if (message.shell) {
    const shell = message.shell;
    return {
      ...base,
      type: 'shell',
      shellID: shell.shellID,
      command: shell.command,
      status: shell.status,
      ...(shell.exit === undefined ? {} : { exit: shell.exit }),
      // `Shell.Output` is the cursor-paged envelope, not a bare string.
      ...(shell.output === undefined
        ? {}
        : {
            output: {
              output: shell.output,
              cursor: Buffer.byteLength(shell.output, 'utf8'),
              size: Buffer.byteLength(shell.output, 'utf8'),
              truncated: false,
            },
          }),
      time:
        message.time.completed === undefined
          ? { created: message.time.created }
          : { created: message.time.created, completed: message.time.completed },
    } as unknown as ProjectedMessage;
  }

  if (message.role === 'user') {
    return {
      ...base,
      type: 'user',
      text: parts
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join(''),
      // `Session.Message.User.time` refuses anything but `created`.
      time: { created: message.time.created },
    };
  }

  // A restore-time notice (the agent resumed the session but cannot replay history):
  // project it as the client's `Session.Message.System`, which the TUI renders as a
  // `◈ Notice` row rather than a conversation turn. The official client appends the same
  // message kind for "Instructions updated"; a notice never counts as dialogue.
  if (message.notice) {
    return {
      ...base,
      type: 'system' as const,
      text: message.notice.text,
      ...(message.notice.description === undefined
        ? {}
        : { description: message.notice.description }),
      time: { created: message.time.created },
    } as unknown as ProjectedMessage;
  }

  return {
    ...base,
    type: 'assistant',
    agent: context.agent,
    model: context.model
      ? { id: context.model.modelID, providerID: context.model.providerID }
      : // Nothing to name a model with; the client's lookup gives up either way,
        // but the reference still has to be well formed.
        { id: 'unknown', providerID: context.agent },
    content: parts.map(contentEntry),
    time:
      message.time.completed === undefined
        ? { created: message.time.created }
        : { created: message.time.created, completed: message.time.completed },
    // `finish` is the schema's "how did this end", and it is written on BOTH outcomes.
    //
    // ★ It used to be written only for an error. A turn that ended normally therefore carried
    // `finish: undefined`, and the TUI kept its spinner up after the answer had finished
    // streaming — the transcript was complete and the screen still said "running". Measured:
    // a resumed (`-c`) session whose assistant row was `completed: true, finish: null`, with
    // `/api/session/active` already empty and two Esc presses answered `{interrupted:false}`
    // (correctly — nothing was running). The missing value, not a stuck turn, was the bug.
    //
    // The enum is `stop | length | tool-calls | content-filter | error | unknown`; a turn that
    // ended with an error gets `error`, everything else `stop`.
    ...(message.error === undefined
      ? { finish: 'stop' as const }
      : {
          error: { type: message.error.name, message: message.error.message },
          finish: 'error' as const,
        }),
  };
}
