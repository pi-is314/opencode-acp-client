/**
 * Capability negotiation and graceful degradation.
 *
 * The whole point of this file: **ACP agents are not interchangeable.** Some
 * implement a rich superset; others (notably the backend's built-in ACP) implement the
 * bare minimum and silently fail — or worse, hang — if you call something they
 * never advertised.
 *
 * So every optional interaction goes through here first, and anything we must
 * decline is declined *explicitly* (a JSON-RPC error or a cancelled outcome)
 * rather than left unanswered. An unanswered request is a hang; a declined one
 * is recoverable.
 */

import type { AgentCapabilities, InitializeResponse } from './types.js';

/** What we learned from `initialize`, normalised to booleans we can trust. */
export interface EffectiveCapabilities {
  /** Agent can replay history for an existing session id. Often false. */
  loadSession: boolean;
  /**
   * Agent supports `session/list`. ACP says a client MUST NOT call it without
   * this gate, so it is a hard boolean rather than "best effort".
   */
  listSessions: boolean;
  /**
   * Agent supports `session/resume` — reconnect to an existing session *without*
   * replaying history. Also a MUST NOT gate: ACP says clients must not call
   * `session/resume` unless `sessionCapabilities.resume` is present.
   *
   * This is the capability that decides what a restored tab looks like on an
   * agent that has no `session/load` (the backend's plain ACP profile is one):
   * resume keeps the agent's context, but no transcript arrives, so the screen
   * starts empty by design rather than by failure.
   */
  resumeSessions: boolean;
  /** Agent accepts image content blocks in a prompt. */
  images: boolean;
  /** Agent accepts audio content blocks in a prompt. */
  audio: boolean;
  /** Agent accepts embedded resources (file contents) in a prompt. */
  embeddedContext: boolean;
  /** The agent offers `opencode/child-session-updates`. */
  childSessionUpdates: boolean;
  /** Whether the agent told us anything at all. */
  reported: boolean;
  /**
   * What to call this agent in the UI. Put together by `displayName()` below: the
   * agent's own `agentInfo.title` (ACP: "intended for UI… human-readable"), else its
   * `agentInfo.name`, else `unknown` — `BridgeServer` then falls back to the launch
   * command, which is always true and reproducible.
   */
  agentName: string;
  /** `agentInfo.name`: the programmatic id, kept for logs and diagnostics. */
  agentId?: string;
}

/**
 * The profile of an agent that has not answered `initialize` yet (or answered
 * uselessly). Exported because there must be exactly ONE such literal: a second
 * hand-written copy in `AcpClient` went stale the moment a field was added.
 */
export const NO_CAPABILITIES: EffectiveCapabilities = {
  loadSession: false,
  listSessions: false,
  resumeSessions: false,
  images: false,
  audio: false,
  embeddedContext: false,
  reported: false,
  childSessionUpdates: false,
  agentName: 'unknown',
};

/**
 * Normalise an `initialize` result. Anything missing is *false*, never
 * "probably fine": opting into an unimplemented feature is how you get a hang.
 */
export function effectiveCapabilities(result: InitializeResponse | undefined): EffectiveCapabilities {
  if (!result || typeof result !== 'object') {
    // Some agents return nothing useful. Treat as the minimal profile.
    return { ...NO_CAPABILITIES };
  }
  const caps: AgentCapabilities = result.agentCapabilities ?? {};
  const prompt = caps.promptCapabilities ?? {};
  // ACP: present and non-null means supported; omitted or null means not.
  const sessionCaps = caps.sessionCapabilities ?? {};
  const agentMeta = (caps as { _meta?: Record<string, unknown> })._meta ?? {};
  return {
    loadSession: caps.loadSession === true,
    listSessions: sessionCaps.list !== undefined && sessionCaps.list !== null,
    resumeSessions: sessionCaps.resume !== undefined && sessionCaps.resume !== null,
    images: prompt.image === true,
    audio: prompt.audio === true,
    embeddedContext: prompt.embeddedContext === true,
    reported: result.agentCapabilities !== undefined,
    childSessionUpdates: agentMeta['opencode/child-session-updates'] === true,
    agentName: displayName(result.agentInfo),
    ...(result.agentInfo?.name ? { agentId: result.agentInfo.name } : {}),
  };
}

/**
 * The name to show for an agent, per ACP's `Implementation` fields.
 *
 * `title` is "intended for UI and end-user contexts — optimized to be human-readable,
 * easily understood. If not provided, the name should be used for display", while
 * `name` is for "programmatic or logical use". We used to read `name` only, so an agent
 * that titled itself nicely still appeared as its id.
 */
export function displayName(info: { name?: unknown; title?: unknown } | undefined): string {
  const title = typeof info?.title === 'string' ? info.title.trim() : '';
  if (title) return title;
  const name = typeof info?.name === 'string' ? info.name.trim() : '';
  return name || 'unknown';
}

/** One thing the caller wanted to do, and whether the agent allows it. */
export interface CapabilityDecision {
  allowed: boolean;
  /** Human-readable reason, used in the HTTP error and the logs. */
  reason: string;
}

export function canLoadSession(caps: EffectiveCapabilities): CapabilityDecision {
  return caps.loadSession
    ? { allowed: true, reason: 'agent advertises loadSession' }
    : {
        allowed: false,
        reason:
          'agent does not advertise session/load; history cannot be replayed. ' +
          'The bridge will start a fresh agent session instead of failing the request.',
      };
}

/**
 * ACP: "Clients **MUST NOT** attempt to call `session/list`" without
 * `sessionCapabilities.list`. Callers that can degrade (a title lookup, a
 * `--session latest` probe) treat a refusal as "no sessions known".
 */
export function canListSessions(caps: EffectiveCapabilities): CapabilityDecision {
  return caps.listSessions
    ? { allowed: true, reason: 'agent advertises sessionCapabilities.list' }
    : {
        allowed: false,
        reason:
          'agent does not advertise sessionCapabilities.list; session/list must not be called',
      };
}

/**
 * ACP: "Before attempting to resume a session, Clients **MUST** verify that the
 * Agent supports this capability by checking the `sessionCapabilities.resume`
 * field in the `initialize` response … If `sessionCapabilities.resume` is not
 * present, the Agent does not support resuming sessions and Clients **MUST NOT**
 * attempt to call `session/resume`."
 *
 * We called it unconditionally once. The backend happened to advertise `resume`,
 * so nothing broke; an agent that advertises neither `resume` nor `loadSession`
 * answered method-not-found, and the rejection escaped into the session-startup
 * path with no session and no visible reason.
 */
export function canResumeSession(caps: EffectiveCapabilities): CapabilityDecision {
  return caps.resumeSessions
    ? { allowed: true, reason: 'agent advertises sessionCapabilities.resume' }
    : {
        allowed: false,
        reason:
          'agent does not advertise sessionCapabilities.resume; session/resume must not be called',
      };
}

/**
 * Prompt content blocks an agent may reject. We drop unsupported blocks rather
 * than forwarding them, because several agents either error out or (worse)
 * accept and then stall when they hit a block type they cannot render.
 */
export function filterPromptBlocks(
  blocks: Array<{ type: string; [k: string]: unknown }>,
  caps: EffectiveCapabilities,
): { kept: Array<{ type: string; [k: string]: unknown }>; dropped: string[] } {
  const dropped: string[] = [];
  const kept = blocks.filter((b) => {
    switch (b.type) {
      case 'image':
        if (!caps.images) {
          dropped.push('image');
          return false;
        }
        return true;
      case 'audio':
        if (!caps.audio) {
          dropped.push('audio');
          return false;
        }
        return true;
      case 'resource':
        if (!caps.embeddedContext) {
          dropped.push(b.type);
          return false;
        }
        return true;
      case 'resource_link':
        // Baseline in ACP: every agent must handle a *link* to a resource; only
        // embedded content (`resource`, file contents inline) needs the
        // `embeddedContext` capability.
        return true;
      case 'text':
        return true;
      default:
        // A block type we do not know cannot be forwarded honestly: the agent's
        // schema may reject it and take the whole turn down. Drop it and let the
        // caller log it — the same path image/audio take.
        dropped.push(b.type);
        return false;
    }
  });
  return { kept, dropped };
}

/**
 * Exactly what we announce as `clientCapabilities` in `initialize`.
 *
 * Kept here so the announcement and the code that honours it are read together.
 * The rule is strict, and it is the reason this is a constant
 * rather than an inline literal: **a capability is a promise the agent may act
 * on.** Announcing one we cannot service means the agent will call it and we
 * will answer with an error (or worse, hang it), so nothing goes in here without
 * a path behind it.
 *
 * | announced | path |
 * |---|---|
 * | `elicitation.form` | `AcpClient.onRequest('elicitation/create')` → `BridgeServer.awaitElicitation` → GET/POST `/api/session/:id/form` (the TUI's own form UI) |
 *
 * Deliberately **absent**, each for a concrete reason:
 * - `elicitation.url` — there is no browser surface to open, and the spec forbids
 *   falling back to form mode for the sensitive flows url mode exists for.
 * - `fs.readTextFile` / `fs.writeTextFile` / `terminal` — not implemented; the
 *   agent should use its own tools (see `clientCallbackSupport`).
 * - `session.notices` / `session.compaction` — opencode v2 has no surface for
 *   them, so announcing would only produce `notice` / `compaction_*` updates
 *   that nothing renders.
 * - `session.configOptions.boolean` — the spec only lets an agent emit a
 *   `type: "boolean"` option once the client advertises it, and the TUI's picker
 *   renders `select` options only (`/api/model` → the model panel); there is no
 *   boolean control in it. Announcing would either promise a control that does
 *   not exist or force a rewrite of the agent's boolean into a two-choice select.
 *   An agent that needs older clients omits the option or offers a `select`
 *   fallback (the spec says so itself), so leaving it out costs nothing.
 */
export const CLIENT_CAPABILITIES = {
  elicitation: { form: {} },
  // ★ `_meta` is ACP's open extension point, and `terminal_output` is the one entry every
  // ACP client that renders a shell card agrees on: Zed announces exactly this pair
  // (`crates/agent_servers/src/acp/v1.rs`, `client_capabilities_for_agent`:
  // `("terminal_output", true)`), and agents branch on it — some agents keep
  // `const terminalOutputMode = () => clientCaps._meta?.['terminal_output'] === true
  //   ? 'terminal_output' : 'terminal_output_delta'`, and only the first form carries the
  // finished command output (`_meta.terminal_output.data`). Without the announcement the
  // agent sends a delta dialect nothing here reads, so the card falls back to its
  // `rawOutput` and shows a JSON record. Announcing it is a negotiation, not a guess:
  // the path that honours it is `toolOutput()` in `translate/events.ts`. It is NOT the
  // `terminal/*` capability below — that one is agent→client *methods*, which we still do
  // not implement and still do not announce.
  // ★ `opencode/child-session-updates` is opencode's negotiated extension for a
  // delegated run's OWN event stream: with it, `opencode acp` sends
  // `opencode/session/child_update` notifications carrying the child's id, its depth,
  // its title and the child's own `session/update` frames. The bridge announces it
  // because it has a path for it (`subagent-sessions.ts`), and only acts when the agent
  // lists it in `agentCapabilities._meta`. Same kind of negotiation as `terminal_output`
  // above: the key is the extension's own name, taken from the adapter
  // (`packages/cli/src/acp/event.ts`), not invented here.
  _meta: { terminal_output: true, 'opencode/child-session-updates': true },
} as const;

/**
 * Whether we are willing to service an agent→client callback.
 *
 * We advertise neither `fs` nor `terminal`, so a well-behaved agent will not call
 * them. A non-conforming one might anyway; we answer with an explicit error so it
 * can fall back instead of waiting forever.
 */
export function clientCallbackSupport(method: string): { supported: boolean; reason: string } {
  if (method === 'elicitation/create') {
    return {
      supported: true,
      reason: 'form mode only; the mode is checked before the handler runs',
    };
  }
  if (method.startsWith('fs/')) {
    return {
      supported: false,
      reason: 'this bridge does not advertise filesystem capabilities; use the agent’s own tools',
    };
  }
  if (method.startsWith('terminal/')) {
    return {
      supported: false,
      reason: 'this bridge does not advertise terminal capabilities; use the agent’s own tools',
    };
  }
  return { supported: true, reason: '' };
}
