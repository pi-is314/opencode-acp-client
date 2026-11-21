/**
 * ACP (Agent Client Protocol) wire types — only the subset this bridge speaks.
 *
 * Design note: ACP is a *negotiated* protocol. Agents differ wildly in what they
 * implement (see `capabilities.ts` and docs/ACP-COMPAT.md). Everything declared
 * here is therefore optional-by-default: the bridge must never assume a field
 * or method exists until `initialize` says so.
 */

/** JSON-RPC 2.0 frame, newline-delimited over stdio. */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

/** `initialize` request params. */
export interface InitializeRequest {
  protocolVersion: number;
  clientCapabilities?: ClientCapabilities;
}

/**
 * What the *client* (us) can do. We advertise almost nothing on purpose: the
 * more we advertise, the more the agent will call back into us, and every
 * callback we fail to implement turns into a hang on the agent's side.
 */
export interface ClientCapabilities {
  fs?: { readTextFile?: boolean; writeTextFile?: boolean };
  terminal?: boolean;
}

/** `initialize` result. Every capability below is optional. */
export interface InitializeResponse {
  protocolVersion?: number;
  agentCapabilities?: AgentCapabilities;
  agentInfo?: { name?: string; version?: string; title?: string };
  authMethods?: unknown[];
}

export interface AgentCapabilities {
  loadSession?: boolean;
  promptCapabilities?: {
    image?: boolean;
    audio?: boolean;
    embeddedContext?: boolean;
  };
  mcpCapabilities?: { http?: boolean; sse?: boolean };
  /**
   * Per-method capability gates. ACP: "Before attempting to list sessions,
   * Clients **MUST** verify that the Agent supports this capability by checking
   * the `sessionCapabilities.list` field in the `initialize` response … If
   * `sessionCapabilities.list` is not present, the Agent does not support
   * listing sessions and Clients **MUST NOT** attempt to call `session/list`."
   *
   * Presence with a non-null value means supported; omitted or null means not.
   */
  sessionCapabilities?: {
    list?: unknown;
    delete?: unknown;
    additionalDirectories?: unknown;
    [key: string]: unknown;
  };
  /** Some builds advertise the ACP protocol revision they actually speak. */
  protocolVersion?: number;
}

export interface SessionNewResponse {
  sessionId: string;
  modes?: unknown;
  models?: unknown;
  /** ACP's standard session configuration options (the backend advertises model + reasoning effort here). */
  configOptions?: SessionConfigOption[];
}

/**
 * ACP `SessionConfigOption`. the backend projects its model list through one option whose
 * `configId` is `model` and whose `category` is `model`, with the choices either
 * flat or grouped by provider.
 */
export interface SessionConfigOption {
  /** the backend sends `id`; ACP's TypeScript surface calls the same field `configId`. */
  id?: string;
  configId?: string;
  name: string;
  description?: string | null;
  category?: string | null;
  type: string;
  currentValue?: string;
  options?: Array<SessionConfigSelectOption | SessionConfigSelectGroup>;
}

export interface SessionConfigSelectOption {
  /** For the backend's model option this is a JSON array string: `["provider","model"]`. */
  value: string;
  name: string;
  description?: string | null;
}

export interface SessionConfigSelectGroup {
  /** the backend sends `group`; ACP's TypeScript surface calls the same field `groupId`. */
  group?: string;
  groupId?: string;
  name: string;
  options?: SessionConfigSelectOption[];
}

export interface ContentBlock {
  type: string;
  [key: string]: unknown;
}

export interface PromptRequest {
  sessionId: string;
  prompt: ContentBlock[];
}

/** `session/prompt` resolves with a stop reason. */
export interface PromptResponse {
  stopReason?: string;
  [key: string]: unknown;
}

/** A `session/update` notification payload (`params.update`). */
export interface SessionUpdate {
  sessionUpdate: string;
  [key: string]: unknown;
}

/** `session/request_permission` params — the options list is agent-defined. */
export interface RequestPermissionRequest {
  sessionId: string;
  toolCall?: { toolCallId?: string; title?: string; kind?: string; [k: string]: unknown };
  options?: Array<{ optionId?: string; name?: string; kind?: string }>;
  [key: string]: unknown;
}

export interface RequestPermissionResponse {
  outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' };
}

/**
 * `elicitation/create` params — the form-mode subset we can serve.
 *
 * ACP defines two modes. We advertise `form` only (see `CLIENT_CAPABILITIES`),
 * and the mode is checked before anything else so a `url` request is refused
 * rather than half-served. The spec is explicit that a client must not fall back
 * from url to form for sensitive flows, so refusing is the correct answer.
 */
export interface ElicitationRequest {
  sessionId?: string;
  requestId?: string | number;
  toolCallId?: string;
  mode?: string;
  message?: string;
  /** Flat JSON Schema: `{type: "object", properties: {...}, required: [...]}`. */
  requestedSchema?: ElicitationSchema;
  [key: string]: unknown;
}

export interface ElicitationSchema {
  type?: string;
  properties?: Record<string, ElicitationProperty>;
  required?: string[];
  [key: string]: unknown;
}

/** The primitive/enum shapes form mode is restricted to. */
export interface ElicitationProperty {
  type?: string;
  title?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  format?: string;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  items?: ElicitationProperty;
  minItems?: number;
  maxItems?: number;
  [key: string]: unknown;
}

export type ElicitationAction = 'accept' | 'decline' | 'cancel';

export interface ElicitationResponse {
  action: ElicitationAction;
  /** Only meaningful for `accept`; must conform to the requested schema. */
  content?: Record<string, string | number | boolean | string[]>;
}

/** ACP `session/update` discriminators we know how to translate. */
export const UPDATE = {
  agentMessageChunk: 'agent_message_chunk',
  agentThoughtChunk: 'agent_thought_chunk',
  userMessageChunk: 'user_message_chunk',
  toolCall: 'tool_call',
  toolCallUpdate: 'tool_call_update',
  plan: 'plan',
  availableCommandsUpdate: 'available_commands_update',
  currentModeUpdate: 'current_mode_update',
  configOptionUpdate: 'config_option_update',
  usageUpdate: 'usage_update',
  sessionInfoUpdate: 'session_info_update',
} as const;
