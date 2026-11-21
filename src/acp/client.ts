/**
 * ACP client: spawns an agent process and speaks ACP JSON-RPC over stdio.
 *
 * Two rules drive the whole implementation:
 *
 *  1. **Every inbound request gets an answer.** An ACP agent that asks us
 *     something and hears nothing will wait forever. So anything we cannot
 *     service is answered with an explicit JSON-RPC error, never dropped.
 *  2. **Timeouts are mandatory.** Several agents have bugs where a request
 *     simply never resolves. Without a timeout the HTTP request waiting on it
 *     would hang for the lifetime of the process.
 */

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { ChildSessionEvent } from '../subagent-sessions.js';

/** `opencode acp`'s notification for one event in a delegated run (see subagent-sessions). */
export const CHILD_UPDATE_METHOD = 'opencode/session/child_update';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';

import {
  CLIENT_CAPABILITIES,
  NO_CAPABILITIES,
  clientCallbackSupport,
  effectiveCapabilities,
  type EffectiveCapabilities,
} from './capabilities.js';
import type {
  ContentBlock,
  ElicitationRequest,
  ElicitationResponse,
  InitializeResponse,
  JsonRpcMessage,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionNewResponse,
  SessionUpdate,
} from './types.js';

export interface AcpClientOptions {
  /** Command to spawn, `my-agent` or `npx`. */
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** How long to wait for any single JSON-RPC response. */
  requestTimeoutMs?: number;
  /**
   * Timeout for `session/prompt` specifically.
   *
   * One timeout for everything was wrong: `initialize` and `session/new` answer in
   * milliseconds, while a prompt is a *task* — an agent may work through a dozen
   * tool calls without touching the wire, and 120s of silence is normal for real
   * work. Measured case: a review task with 20+ tool calls was killed mid-flight by
   * the request timeout, and the turn ended with `timed out waiting for
   * session/prompt` while the agent was still working.
   */
  promptTimeoutMs?: number;
  /** Protocol revision we claim. Agents negotiate down. */
  protocolVersion?: number;
  /** Sink for diagnostics; never written to stdout (that is the ACP wire). */
  onLog?: (line: string) => void;
}

export interface AcpEvents {
  /** A `session/update` notification. */
  update: [sessionId: string, update: SessionUpdate];
  /** The agent exited; no further calls will succeed. */
  exit: [{ code: number | null; signal: string | null }];
  /**
   * One event of a delegated run (`opencode/session/child_update`), keyed by the ROOT
   * session so it lands on the transcript that owns the subagent card.
   */
  child: [rootSessionId: string, event: ChildSessionEvent];
  /** Diagnostics. */
  log: [line: string];
}

/** Raised when the agent answered with a JSON-RPC error. */
export class AcpError extends Error {
  constructor(
    message: string,
    readonly code: number | string = 'acp-error',
  ) {
    super(message);
    this.name = 'AcpError';
  }
}

/** The agent does not implement the method we called. */
export class AcpMethodNotFound extends AcpError {
  constructor(method: string) {
    super(`agent does not implement ${method}`, -32601);
    this.name = 'AcpMethodNotFound';
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer?: NodeJS.Timeout;
  method: string;
}

export class AcpClient extends EventEmitter<AcpEvents> {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number | string, Pending>();
  private readonly timeoutMs: number;
  private readonly promptTimeoutMs: number;
  private readonly protocolVersion: number;
  private nextId = 1;
  private buffer = '';
  private closed = false;
  private caps: EffectiveCapabilities | null = null;
  private agentVersion: string | undefined;
  private pendingRecordedFrames: JsonRpcMessage[] = [];
  private recordFlushed = false;
  private recordFile: string | undefined;
  /** Permission requests the agent is currently blocked on. */
  private permissionHandler:
    | ((req: RequestPermissionRequest) => Promise<RequestPermissionResponse>)
    | null = null;
  /** `elicitation/create` — the agent asking the user something. */
  private elicitationHandler:
    | ((req: ElicitationRequest) => Promise<ElicitationResponse>)
    | null = null;

  constructor(private readonly options: AcpClientOptions) {
    super();
    this.timeoutMs = options.requestTimeoutMs ?? 120_000;
    // ★ No prompt clock by default (2026-10-20). A real long task was killed
    // twice at 30 minutes while the agent was still working; the TUI showed "timed
    // out waiting for session/prompt", the agent kept its prompt active, and the
    // user had to type "continue". ACP has no server-side prompt timeout, and the
    // TUI's Esc/interrupt is the user's stop control. Set the env (or the option)
    // to a positive number to restore a clock.
    this.promptTimeoutMs =
      options.promptTimeoutMs ??
      (Number(process.env['OPENCODE_ACP_CLIENT_PROMPT_TIMEOUT_MS']) > 0
        ? Number(process.env['OPENCODE_ACP_CLIENT_PROMPT_TIMEOUT_MS'])
        : 0);
    this.protocolVersion = options.protocolVersion ?? 1;

    const env: NodeJS.ProcessEnv = { ...process.env, ...(options.env ?? {}) };
    // Strip anything that would make the agent try to phone home during tests.
    env.NO_COLOR = env.NO_COLOR ?? '1';

    this.child = spawn(options.command, options.args ?? [], {
      cwd: options.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Its own process group on POSIX, so dispose can kill the whole tree. An agent
      // that forks helpers (shells, watchers) used to leave them behind: `child.kill`
      // only reaches the direct child, and the survivors became `ppid=1` orphans that
      // keep workspace locks (measured twice with dsh).
      detached: process.platform !== 'win32',
    });

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.onStdout(chunk));

    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (line.trim()) this.emit('log', `[agent] ${line}`);
      }
    });

    this.child.on('error', (err) => {
      this.failAll(new AcpError(`failed to start agent: ${err.message}`, 'spawn-failed'));
    });
    this.child.on('exit', (code, signal) => {
      this.closed = true;
      this.failAll(new AcpError(`agent exited (code=${code} signal=${signal})`, 'agent-exited'));
      this.emit('exit', { code, signal });
    });
  }

  get capabilities(): EffectiveCapabilities {
    // Before `initialize` answers, the honest profile is "nothing advertised".
    return this.caps ?? NO_CAPABILITIES;
  }

  /** Register the handler used to resolve `session/request_permission`. */
  onPermission(
    handler: (req: RequestPermissionRequest) => Promise<RequestPermissionResponse>,
  ): void {
    this.permissionHandler = handler;
  }

  /**
   * Register the handler used to answer `elicitation/create`.
   *
   * Only ever called for `mode: "form"` — the mode we advertise. The handler may
   * throw to refuse the request outright; that becomes a JSON-RPC error, which is
   * the honest answer when the requested schema cannot be rendered.
   */
  onElicitation(handler: (req: ElicitationRequest) => Promise<ElicitationResponse>): void {
    this.elicitationHandler = handler;
  }

  /**
   * `initialize`. Failure here is fatal: without it we do not know what the
   * agent supports, and guessing is how hangs happen.
   */
  async initialize(): Promise<EffectiveCapabilities> {
    const result = await this.request<InitializeResponse>('initialize', {
      protocolVersion: this.protocolVersion,
      // Only what has a path behind it. See CLIENT_CAPABILITIES.
      clientCapabilities: CLIENT_CAPABILITIES,
    });
    this.caps = effectiveCapabilities(result);
    const info = (result as { agentInfo?: { version?: unknown } }).agentInfo;
    if (typeof info?.version === 'string') this.agentVersion = info.version;
    // The header needs the agent's name, which only exists after this response.
    this.flushRecordedFrames();
    this.emit('log', `initialized: ${JSON.stringify(this.caps)}`);
    return this.caps;
  }

  async newSession(cwd: string): Promise<SessionNewResponse> {
    const result = await this.request<SessionNewResponse>('session/new', { cwd, mcpServers: [] });
    this.catalog(result.sessionId).configOptions = result.configOptions ?? [];
    this.noteStandardModels(result.sessionId, result);
    if (process.env.OPENCODE_ACP_CLIENT_DUMP) {
      try {
        writeFileSync(process.env.OPENCODE_ACP_CLIENT_DUMP, JSON.stringify(result, null, 2));
      } catch {
        /* diagnostics only */
      }
    }
    return result;
  }

  /**
   * Per-SESSION catalogs: the config options and the standard `models` list are
   * session-scoped in ACP (`session/new`/`load`/`resume` each carry their own), so
   * they are kept per session id rather than in one field. One field was fine while
   * one client meant one session; a shared connection would let the newest session's
   * defaults (and a `set_config_option` meant for another session) leak across.
   */
  private catalogs = new Map<
    string,
    {
      configOptions: SessionConfigOption[];
      standardModels?:
        | { currentModelId?: string; availableModels?: Array<{ modelId?: string; name?: string }> }
        | undefined;
    }
  >();
  private lastSessionId: string | undefined;

  /** (Re)select a session's catalog state, remembering it as the most recent one. */
  private catalog(sessionId: string): {
    configOptions: SessionConfigOption[];
    standardModels?:
      | { currentModelId?: string; availableModels?: Array<{ modelId?: string; name?: string }> }
      | undefined;
  } {
    let state = this.catalogs.get(sessionId);
    if (!state) {
      state = { configOptions: [] };
      this.catalogs.set(sessionId, state);
    }
    this.lastSessionId = sessionId;
    return state;
  }

  /** The options a given session advertised; omitted = the most recently touched one. */
  configOptionsFor(sessionId?: string): SessionConfigOption[] {
    const id = sessionId ?? this.lastSessionId;
    return id ? (this.catalogs.get(id)?.configOptions ?? []) : [];
  }

  /** Any session on this connection advertised a catalog (pool-aware). */
  hasCatalog(): boolean {
    for (const state of this.catalogs.values()) {
      if (state.configOptions.length > 0) return true;
    }
    return false;
  }

  /**
   * The ACP-standard model list: `models: {currentModelId, availableModels[]}`.
   *
   * Agents that use it (qwen, and per the ecosystem survey gemini and kimi) put their
   * models here rather than in an opencode-shaped `configOptions` entry — we ignored
   * the field entirely, so their model picker came up empty (`/api/model` stayed on the
   * `acp/default` placeholder) even though the agent had just told us every model it
   * has. Measured: qwen --acp returns four models this way.
   */
  private noteStandardModels(sessionId: string, result: SessionNewResponse): void {
    const models = result.models as
      | { currentModelId?: string; availableModels?: Array<{ modelId?: string; name?: string }> }
      | undefined;
    const available = models?.availableModels ?? [];
    if (available.length === 0) return;
    const state = this.catalog(sessionId);
    state.standardModels = models;
    // ★ Merge the two sources by IDENTITY, and let `configOptions` own the spelling when
    // both describe the same model.
    //
    // Measured on shapers that disagree:
    //   • codex-acp 2.8.0 — `configOptions` says `deepseek-flash`, while `models` says
    //     `deepseek-flash[none]` / `[high]` / `[max]` (a reasoning-effort suffix). Appending
    //     the second on top of the first put the suffixed values in the picker; the TUI
    //     submitted the unsuffixed one it had read from `configOptions`, the lookup found no
    //     match, the request fell back to `acp/deepseek-flash`, codex refused it with
    //     `Internal error`, and the session never set up.
    //   • qwen --acp — both lists carry the identical ids, so appending only duplicated rows.
    //
    // So: keep every `configOptions` value, and add a `models` entry only when no existing
    // option already means that model (compared with any `[suffix]` stripped).
    const existing = new Set<string>();
    for (const option of state.configOptions) {
      if (option.category !== 'model' && option.id !== 'model') continue;
      for (const entry of option.options ?? []) {
        const group = entry as { options?: Array<{ value?: string }>; value?: string };
        const values = Array.isArray(group.options)
          ? group.options.map((choice) => choice.value)
          : [group.value];
        for (const value of values) {
          if (typeof value !== 'string') continue;
          // `["provider","model"]` and `provider::model` both reduce to the model id.
          const bare = value.replace(/\[[^\]]*\]$/, '');
          existing.add(bare);
          try {
            const parsed = JSON.parse(value) as unknown;
            if (Array.isArray(parsed) && typeof parsed[1] === 'string') existing.add(parsed[1]);
          } catch {
            /* not JSON: the raw string is the id */
          }
        }
      }
    }
    const novel = available.filter((model) => {
      const id = String(model.modelId ?? '');
      return id !== '' && !existing.has(id) && !existing.has(id.replace(/\[[^\]]*\]$/, ''));
    });
    if (novel.length === 0) return;
    state.configOptions = [
      ...state.configOptions,
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: JSON.stringify([models?.currentModelId ?? novel[0]?.modelId ?? '', '']),
        options: novel.map((model) => ({
          value: JSON.stringify([model.modelId ?? '', model.modelId ?? '']),
          name: model.name ?? String(model.modelId ?? ''),
        })),
      } as SessionConfigOption,
    ];
  }

  get configOptions(): SessionConfigOption[] {
    return this.configOptionsFor();
  }

  /**
   * `session/load`. Caller must check `capabilities.loadSession` first.
   * Agents without `loadSession` get an explicit, catchable error.
   */
  async loadSession(sessionId: string, cwd: string): Promise<void> {
    if (!this.capabilities.loadSession) {
      throw new AcpMethodNotFound('session/load');
    }
    const result = await this.request<SessionNewResponse>('session/load', {
      sessionId,
      cwd,
      mcpServers: [],
    });
    // A replay carries the session's config options too, and that is where a
    // resumed session's model list comes from - `session/new` never runs for it.
    // `?? []` and not `?? this.sessionConfig`... except agents that send the config
    // as a `config_option_update` *notification* before the response (the fixture does;
    // real agents vary) have it applied by the update listener already, and a bare
    // response then wiped it back to empty — measured: the catalog stayed on the
    // placeholder forever after a restart, the client showed `model-1 (unavailable)`
    // and refused to submit. The response wins when it carries options; when it does
    // not, whatever the notifications already applied stands.
    if (Array.isArray(result.configOptions)) this.catalog(sessionId).configOptions = result.configOptions;
    this.noteStandardModels(sessionId, result);
  }

  /**
   * `session/resume`. ACP defines it as "reconnect to an existing session WITHOUT
   * replaying history" — and that is all it promises.
   *
   * Measured on the backend's plain ACP profile (2026-10-17, probes in
   * docs/KNOWN-ISSUES.md): the call succeeds, the response carries configOptions, no
   * updates follow, and the next turn runs. Whether the agent's model actually still
   * has the earlier conversation was **not consistent**: the same profile answered
   * "there's no word I was asked to remember in this conversation" under one model
   * and recalled the word correctly under another.
   *
   * So describe only what is guaranteed: same session id, empty transcript, and the
   * conversation's continuity left to the agent. Never promise that context survived.
   */
  async resumeSession(sessionId: string, cwd: string): Promise<SessionNewResponse> {
    // ACP: a client MUST NOT call `session/resume` without
    // `sessionCapabilities.resume`. Refusing here (as `listSessions` does) keeps
    // the gate in one place, so no future caller can quietly violate it.
    if (!this.capabilities.resumeSessions) {
      throw new AcpMethodNotFound('session/resume');
    }
    const result = await this.request<SessionNewResponse>('session/resume', { sessionId, cwd });
    this.catalog(sessionId).configOptions = result.configOptions ?? [];
    this.noteStandardModels(sessionId, result);
    return result;
  }

  /**
   * `session/list`. the backend returns `{sessionId, cwd}` entries newest first, 100 per
   * page with a cursor. An unpaginated read only ever sees recent sessions — for a
   * directory whose sessions are all older, a "latest" lookup finds nothing.
   */
  async listSessions(cwd: string, maxPages = 10): Promise<Array<{ sessionId: string; cwd: string; title?: string }>> {
    // ACP: a client MUST NOT call `session/list` without `sessionCapabilities.list`.
    // Refusing here (rather than in each caller) keeps the gate in one place.
    if (!this.capabilities.listSessions) {
      throw new AcpMethodNotFound('session/list');
    }
    const all: Array<{ sessionId: string; cwd: string; title?: string }> = [];
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page += 1) {
      const result = await this.request<{
        sessions?: Array<{ sessionId: string; cwd: string; title?: string }>;
        nextCursor?: string | null;
      }>('session/list', cursor ? { cwd, cursor } : { cwd });
      all.push(...(result.sessions ?? []));
      cursor = result.nextCursor ?? undefined;
      if (!cursor) break;
    }
    return all;
  }

  async prompt(sessionId: string, prompt: ContentBlock[]): Promise<PromptResponse> {
    return this.request<PromptResponse>(
      'session/prompt',
      { sessionId, prompt },
      this.promptTimeoutMs > 0 ? this.promptTimeoutMs : null,
    );
  }

  /**
   * `session/set_config_option`. the backend advertises models through a config option
   * (`id: "model"`), so this is how a model switch reaches the agent.
   *
   * Returns the config state the agent answered with: the spec requires the
   * response to carry the **complete** list, which is how dependent changes
   * (reasoning options that follow the model, for instance) reach us at all.
   */
  /**
   * Tell the agent a session is gone (`session/delete`, a stable agent method).
   *
   * Without this the agent keeps the session it created: the bridge forgets it, the
   * UI forgets it, and the agent's own store keeps growing. Best-effort by design —
   * the user asked to delete, and that must succeed locally even if the agent cannot
   * honour it.
   */
  async deleteSession(sessionId: string): Promise<void> {
    await this.request('session/delete', { sessionId });
  }

  /**
   * The spelling `set_model` expects for a model the caller names by its bare id.
   *
   * An agent that publishes `models.availableModels` may append a variant to the id
   * (`deepseek-flash[high]`) while `configOptions` offers the bare one; the two
   * methods accept different spellings (see `setConfig`). Match on the bare part and
   * return the standard list's own string, so neither the picker nor the wire has to
   * know which surface the user clicked on.
   */
  private resolveStandardModelId(
    state: { standardModels?: { availableModels?: Array<{ modelId?: string }> } | undefined },
    modelId: string,
  ): string | undefined {
    const available = state.standardModels?.availableModels ?? [];
    if (available.length === 0) return undefined;
    const bare = (id: string): string => id.replace(/\[[^\]]*\]$/, '');
    const exact = available.find((model) => model.modelId === modelId);
    if (exact?.modelId) return exact.modelId;
    const sameModel = available.find((model) => typeof model.modelId === 'string' && bare(model.modelId) === bare(modelId));
    return sameModel?.modelId;
  }

  async setConfig(sessionId: string, configId: string, value: string): Promise<SessionConfigOption[]> {
    // An agent whose models arrived in the standard `models` field switches them with
    // `session/set_model` (that is the family gemini and kimi use too), not by writing
    // a config option we synthesised on its behalf.
    const state = this.catalog(sessionId);
    if (configId === 'model' && state.standardModels) {
      let modelId = value;
      try {
        const parsed = JSON.parse(value) as unknown;
        if (Array.isArray(parsed) && typeof parsed[1] === 'string') modelId = parsed[1];
      } catch {
        /* a bare model id is fine too */
      }
      // ★ `set_model` wants the id EXACTLY as `models.availableModels` spells it, which
      // is not always what `configOptions` offers. Measured on codex-acp 2.8.0:
      //   session/set_config_option + `deepseek-flash`      -> OK
      //   session/set_model        + `deepseek-flash`      -> "Unsupported format of
      //                                                       modelId … Expected: modelId[effort]"
      //   session/set_model        + `deepseek-flash[high]` -> OK
      // The caller has the bare id (that is what the picker shows), so resolve it
      // against the standard list before switching — matching on the part before
      // `[`, which is the model's identity on both sides.
      const wanted = this.resolveStandardModelId(state, modelId) ?? modelId;
      await this.request('session/set_model', { sessionId, modelId: wanted });
      if (state.standardModels) state.standardModels.currentModelId = wanted;
      return state.configOptions;
    }
    // `value` goes on the wire as a bare string, NOT as the `{type:"id", value}`
    // envelope the ACP SDK types declare. the backend validates the envelope away with
    // zod and hands the inner value straight to a `typeof value !== "string"`
    // check, so the SDK-shaped object is rejected as "Invalid params".
    //
    // Probed against the backend directly:
    //   {type:"id", value:"['p','m']"} -> Invalid params
    //   "['p','m']"                     -> accepted, configOptions returned
    const result = await this.request<{ configOptions?: SessionConfigOption[] }>(
      'session/set_config_option',
      { sessionId, configId, value },
    );
    this.applyConfigOptions(sessionId, result?.configOptions);
    return state.configOptions;
  }

  /**
   * Replace the session's config options.
   *
   * Used for both halves of the negotiation: the reply to a `set_config_option`,
   * and an agent-pushed `config_option_update` (the spec sends the complete state
   * in both, so replacing is correct — merging would keep stale values alive).
   */
  applyConfigOptions(sessionId: string, options: SessionConfigOption[] | undefined): void {
    if (Array.isArray(options)) this.catalog(sessionId).configOptions = options;
  }

  /** `session/cancel` is a notification: fire and forget, per the spec. */
  cancel(sessionId: string): void {
    this.notify('session/cancel', { sessionId });
  }

  /** Terminate the agent. Safe to call repeatedly. */
  /** Signal the agent AND its descendants (one process group on POSIX). */
  private killGroup(signal: NodeJS.Signals): void {
    const pid = this.child.pid;
    if (pid === undefined) return;
    if (process.platform === 'win32') {
      // Windows has no process group we can signal: `taskkill /T` walks the tree.
      // Without /F it asks the app to close (our SIGTERM step); /F is the force
      // step. A failure falls through to the direct-child kill below.
      try {
        spawnSync('taskkill', windowsKillArgs(pid, signal), { stdio: 'ignore' });
        return;
      } catch {
        /* taskkill missing; fall through */
      }
    }
    if (process.platform !== 'win32') {
      try {
        process.kill(-pid, signal);
        return;
      } catch {
        /* the group is already gone, or it never became a group leader */
      }
    }
    try {
      this.child.kill(signal);
    } catch {
      /* already gone */
    }
  }

  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new AcpError('client disposed', 'disposed'));
    try {
      this.child.stdin.end();
    } catch {
      /* already gone */
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        try {
          this.killGroup('SIGKILL');
        } catch {
          /* ignore */
        }
        resolve();
      }, 3000);
      this.child.once('exit', () => {
        clearTimeout(t);
        // The leader is gone; helpers that ignored SIGTERM would linger as orphans.
        this.killGroup('SIGKILL');
        resolve();
      });
      try {
        this.killGroup('SIGTERM');
      } catch {
        clearTimeout(t);
        resolve();
      }
    });
  }

  // ---------------------------------------------------------------- internals

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(line) as JsonRpcMessage;
      } catch {
        this.emit('log', `[agent] unparseable frame: ${line.slice(0, 200)}`);
        continue;
      }
      this.recordFrame(msg);
      void this.onMessage(msg);
    }
  }

  /**
   * `OPENCODE_ACP_CLIENT_RECORD_FRAMES=<dir>`: append every inbound frame to
   * `<dir>/<backend>.jsonl`, headed by a provenance line.
   *
   * A recorded turn is the only fixture that carries a REAL agent's shapes — the
   * synthetic fake agent can only exercise shapes we thought of. The corpus format
   * follows KiroCrew's: the first line is `_meta` (backend, recorded, date,
   * agent_version) and every line after it is the wire verbatim, so a replay can
   * be weighed against what produced it. Recording never breaks the wire: a
   * write failure is logged and dropped.
   */
  private recordFrame(msg: JsonRpcMessage): void {
    if (!process.env.OPENCODE_ACP_CLIENT_RECORD_FRAMES) return;
    if (this.recordFlushed && this.recordFile) {
      try {
        appendFileSync(this.recordFile, `${JSON.stringify(msg)}\n`);
      } catch (err) {
        this.emit('log', `[record] ${String(err)}`);
      }
      return;
    }
    this.pendingRecordedFrames.push(msg);
    // Frames that arrive before `initialize` answers are buffered: the header needs
    // the agent's own name, and writing it first with `unknown` would mislabel a
    // corpus that a replay later weighs by its backend.
    if (this.caps) this.flushRecordedFrames();
  }

  /** Write the buffered frames (header first) once the backend is known. */
  private flushRecordedFrames(): void {
    const dir = process.env.OPENCODE_ACP_CLIENT_RECORD_FRAMES;
    if (!dir || this.recordFlushed) return;
    this.recordFlushed = true;
    try {
      mkdirSync(dir, { recursive: true });
      const backend = (this.caps?.agentName ?? 'unknown').replace(/[^\w.-]+/g, '-');
      const file = join(dir, `${backend}.jsonl`);
      this.recordFile = file;
      const header = {
        _meta: {
          backend,
          recorded: 'live',
          date: new Date().toISOString().slice(0, 10),
          agent_version: this.agentVersion ?? 'unmeasured',
        },
      };
      const body = this.pendingRecordedFrames.map((frame) => JSON.stringify(frame)).join('\n');
      appendFileSync(file, `${JSON.stringify(header)}\n${body}${body ? '\n' : ''}`);
      this.pendingRecordedFrames = [];
    } catch (err) {
      this.emit('log', `[record] ${String(err)}`);
    }
  }

  private async onMessage(msg: JsonRpcMessage): Promise<void> {
    // Raw frame tracing: the only way to tell "the agent sent nothing" apart
    // from "we dropped what it sent".
    if (process.env.OPENCODE_ACP_CLIENT_TRACE) {
      this.emit('log', `[recv] ${JSON.stringify(msg).slice(0, 4000)}`);
    }
    if ('method' in msg && msg.method) {
      if ('id' in msg && msg.id !== undefined) {
        await this.onRequest(msg.id, msg.method, msg.params);
      } else {
        this.onNotification(msg.method, msg.params);
      }
      return;
    }
    const response = msg as { id: number | string; result?: unknown; error?: Pending extends never ? never : { code: number; message: string } };
    const pending = this.pending.get(response.id);
    if (!pending) {
      this.emit('log', `[agent] response for unknown id ${String(response.id)}`);
      return;
    }
    this.pending.delete(response.id);
    clearTimeout(pending.timer);
    if (response.error) {
      pending.reject(new AcpError(response.error.message, response.error.code));
    } else {
      pending.resolve(response.result);
    }
  }

  private onNotification(method: string, params: unknown): void {
    if (method === 'session/update') {
      const p = (params ?? {}) as { sessionId?: string; update?: SessionUpdate };
      if (typeof p.sessionId === 'string' && p.update) {
        // Config state is recorded on the client, not by a listener: the
        // translator attaches on the first prompt, and an agent that announces
        // new options between session/new and that point would otherwise be
        // silently ignored (and its model change lost).
        if (p.update.sessionUpdate === 'config_option_update') {
          this.applyConfigOptions(
            p.sessionId,
            p.update['configOptions'] as SessionConfigOption[] | undefined,
          );
        }
        // `_meta` may sit on the notification params, on the update, or both.
        // ACP reserves it for extensions, so it is merged and handed on rather
        // than dropped — never overwriting the agent's own keys.
        const paramsMeta = (p as { _meta?: unknown })._meta;
        const updateMeta = p.update['_meta'];
        const meta = {
          ...(paramsMeta && typeof paramsMeta === 'object' ? (paramsMeta as Record<string, unknown>) : {}),
          ...(updateMeta && typeof updateMeta === 'object' ? (updateMeta as Record<string, unknown>) : {}),
        };
        this.emit('update', p.sessionId, Object.keys(meta).length > 0 ? { ...p.update, _meta: meta } : p.update);
      }
      return;
    }
    // opencode's delegated-run stream: a second stream of `session/update`-shaped frames
    // belonging to the same session as its parent. Handed to the translator, which owns
    // everything the client renders.
    if (method === CHILD_UPDATE_METHOD) {
      const p = (params ?? {}) as { rootSessionId?: unknown };
      if (typeof p.rootSessionId === 'string') {
        this.emit('child', p.rootSessionId, params as ChildSessionEvent);
        return;
      }
    }
    this.emit('log', `[agent] notification ${method}`);
  }

  /**
   * Agent→client request. This is where "answer everything" matters most:
   * an unhandled request is a deadlock, and a *silently* unhandled one is the
   * hardest class of bug to find later.
   */
  private async onRequest(id: number | string, method: string, params: unknown): Promise<void> {
    try {
      if (method === 'session/request_permission') {
        const req = (params ?? {}) as RequestPermissionRequest;
        if (!this.permissionHandler) {
          // Nobody is listening. Answer with an explicit cancel so the agent can
          // fail closed rather than wait forever.
          this.respond(id, { outcome: { outcome: 'cancelled' } });
          return;
        }
        const answer = await this.permissionHandler(req);
        this.respond(id, answer);
        return;
      }

      if (method === 'elicitation/create') {
        const req = (params ?? {}) as ElicitationRequest;
        // Checked before the handler: we advertise `form` only, and a url request
        // must be refused rather than answered with a form (the spec forbids that
        // fallback precisely because url mode carries the sensitive flows).
        if (req.mode !== 'form') {
          this.respondError(
            id,
            -32602,
            `only form elicitation is supported (mode=${req.mode === undefined ? 'undefined' : String(req.mode)})`,
          );
          return;
        }
        if (!this.elicitationHandler) {
          // Fail closed, not silent: `cancel` is one of the three documented
          // outcomes, and the agent is required to cope with it.
          this.respond(id, { action: 'cancel' });
          return;
        }
        this.respond(id, await this.elicitationHandler(req));
        return;
      }

      const support = clientCallbackSupport(method);
      if (!support.supported) {
        // Explicit refusal beats silence: the agent can degrade.
        this.respondError(id, -32601, support.reason);
        return;
      }

      this.respondError(id, -32601, `bridge does not handle ${method}`);
    } catch (err) {
      // An `AcpError` carries a deliberate code (e.g. -32602 for a schema we
      // cannot render); anything else is an internal failure.
      if (err instanceof AcpError && typeof err.code === 'number') {
        this.respondError(id, err.code, err.message);
        return;
      }
      this.respondError(id, -32603, err instanceof Error ? err.message : String(err));
    }
  }

  private request<T>(
    method: string,
    params: unknown,
    timeoutMs: number | null = this.timeoutMs,
  ): Promise<T> {
    if (this.closed) {
      return Promise.reject(new AcpError('agent is not running', 'agent-exited'));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer =
        timeoutMs === null
          ? undefined
          : setTimeout(() => {
              this.pending.delete(id);
              reject(new AcpError(`timed out waiting for ${method}`, 'timeout'));
            }, timeoutMs);
      timer?.unref?.();
      this.pending.set(id, {
        method,
        timer,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  private notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  private respond(id: number | string, result: unknown): void {
    this.write({ jsonrpc: '2.0', id, result });
  }

  private respondError(id: number | string, code: number, message: string): void {
    this.write({ jsonrpc: '2.0', id, error: { code, message } });
  }

  private write(message: unknown): void {
    if (this.closed) return;
    try {
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch (err) {
      this.emit('log', `failed to write to agent: ${String(err)}`);
    }
  }

  private failAll(err: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
      this.pending.delete(id);
    }
  }
}

/**
 * The `taskkill` arguments that end an agent AND its descendants on Windows.
 *
 * Windows has no signalable process groups, so the portable `process.kill(-pid)`
 * has nothing to do; `taskkill /T` is the tree walk. `/F` is the force step: the
 * SIGKILL pass uses it, the SIGTERM pass lets the app close first.
 */
export function windowsKillArgs(pid: number, signal: NodeJS.Signals): string[] {
  return ['/PID', String(pid), '/T', ...(signal === 'SIGKILL' ? ['/F'] : [])];
}
