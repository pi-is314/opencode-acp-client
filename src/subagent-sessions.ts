/**
 * `opencode/session/child_update` — opencode's own extension for a delegated run.
 *
 * ACP has an RFD for this ("Subagent Sessions", each child its own session id), but
 * `opencode acp` ships this quieter negotiated form instead: announced as
 * `agentCapabilities._meta["opencode/child-session-updates"]` and delivered as one
 * notification per child event.
 *
 *   { rootSessionId, childSessionId, parentSessionId, depth, title?,
 *     type: "update", update: <the child's own session/update> }
 * | { …, type: "status", status: "created"|"running"|"completed"|"failed"|"interrupted" }
 *
 * ★ What it is NOT for: it does not create a second session. opencode's TUI would need a
 * real session in the strip to open one, and a tab the user never opened is the wrong
 * shape for a delegated run. It exists to put the child's ACTIVITY on the card that
 * reports it — the two slots that component actually renders:
 *
 *   • the caption (`input.description`, via `session.tool.called`) — the only free text;
 *   • the `Background` badge (`metadata.status`, via `session.tool.progress`), which the
 *     client shows when the card is `completed` but `metadata.status === "running"`
 *     (`isBackgroundSubagent`). A delegated run that returned its card while still
 *     working is exactly that case.
 *
 * Shape taken from `packages/cli/src/acp/event.ts` (`ChildSessionUpdate`); nothing here
 * is invented.
 */

export type ChildStatus = 'created' | 'running' | 'completed' | 'failed' | 'interrupted';

export interface ChildSessionEvent {
  rootSessionId?: string;
  childSessionId?: string;
  parentSessionId?: string;
  depth?: number;
  title?: string;
  type?: string;
  status?: ChildStatus;
  error?: { type?: string; message?: string };
  update?: { sessionUpdate?: string; [key: string]: unknown };
}

/** What one delegated run has done so far. */
export interface ChildProgress {
  childSessionId: string;
  title?: string;
  status: ChildStatus;
  /** How many tool calls the child has made. */
  toolCalls: number;
  /** The most recent tool the child used, or what it is doing (thinking/writing). */
  lastActivity?: string;
  error?: string;
}

/**
 * Fold one child event into the record for that child.
 *
 * Returns the updated record so the caller can refresh the card; a frame that carries
 * nothing new returns undefined, which keeps a chatty agent from churning the transcript.
 */
export function applyChildEvent(
  known: ChildProgress | undefined,
  event: ChildSessionEvent,
): ChildProgress | undefined {
  const childSessionId = typeof event.childSessionId === 'string' ? event.childSessionId : undefined;
  if (!childSessionId) return undefined;
  const next: ChildProgress = known ?? { childSessionId, status: 'running', toolCalls: 0 };
  if (typeof event.title === 'string' && event.title) next.title = event.title;

  if (event.type === 'status') {
    if (!event.status || event.status === next.status) return undefined;
    next.status = event.status;
    if (event.error?.message) next.error = event.error.message;
    return next;
  }
  if (event.type !== 'update' || !event.update) return undefined;

  const kind = event.update.sessionUpdate;
  if (typeof kind !== 'string') return undefined;
  if (kind === 'tool_call') next.toolCalls += 1;
  const activity = describe(kind, event.update);
  if (activity === next.lastActivity) return undefined;
  if (activity) next.lastActivity = activity;
  // A tool_call is itself news even when its caption repeats.
  return kind === 'tool_call' || activity !== undefined ? next : undefined;
}

/** A short phrase for the caption. Never reads agent prose beyond the tool's own name. */
function describe(kind: string, update: { [key: string]: unknown }): string | undefined {
  if (kind === 'tool_call' || kind === 'tool_call_update') {
    const title = typeof update['title'] === 'string' ? update['title'] : undefined;
    const name = typeof update['name'] === 'string' ? update['name'] : undefined;
    return title || name;
  }
  if (kind === 'agent_thought_chunk') return 'thinking';
  if (kind === 'agent_message_chunk') return 'writing';
  if (kind === 'plan') return 'planning';
  return undefined;
}

/**
 * The parenthetical appended to the card's caption.
 *
 * The agent's own description is kept verbatim and the progress follows in brackets, so
 * the card still says what it was asked to do — the parenthetical is visibly secondary.
 */
export function childCaption(progress: ChildProgress): string | undefined {
  const parts: string[] = [];
  if (progress.status === 'failed') {
    if (progress.error) parts.push(`failed: ${progress.error}`);
  } else if (progress.status === 'interrupted') {
    parts.push('interrupted');
  } else {
    if (progress.toolCalls > 0) parts.push(`${progress.toolCalls} call${progress.toolCalls === 1 ? '' : 's'}`);
    if (progress.lastActivity) parts.push(progress.lastActivity);
    if (progress.status === 'completed') parts.push('done');
  }
  return parts.length > 0 ? parts.join(', ') : undefined;
}

/** Whether the client should show its `Background` badge for this child. */
export function isStillRunning(progress: ChildProgress): boolean {
  return progress.status === 'running';
}
