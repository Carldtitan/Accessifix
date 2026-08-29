/**
 * Typed HTTP client for the TrueForge control plane.
 *
 * Every response is parsed with zod before it leaves this module, so nothing
 * downstream ever handles an unvalidated payload. Every failure — network,
 * timeout, HTTP status, schema mismatch — surfaces as a `TrueForgeError`.
 * A raw `fetch` rejection never escapes.
 *
 * Verified against TrueForge 0.2.0-rc.0 on 2026-08-29:
 *   base URL `http://localhost:8790`, API under `/api/v1`, auth disabled
 *   locally, so no `Authorization` header is sent when the key is empty.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Response schemas
// ---------------------------------------------------------------------------

const envelope = <T extends z.ZodType>(inner: T) => z.object({ data: inner });

export const ModelParamsSchema = z.looseObject({
  max_tokens: z.number().optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  top_k: z.number().optional(),
  parallel_tool_calls: z.boolean().optional(),
  reasoning_effort: z.string().optional(),
});
export type ModelParams = z.infer<typeof ModelParamsSchema>;

/** `provider/model`, e.g. `anthropic/claude-opus-5`. */
export const ModelRefSchema = z.looseObject({
  name: z.string().min(1),
  params: ModelParamsSchema.optional(),
});
export type ModelRef = z.infer<typeof ModelRefSchema>;

export const ModelPropertiesSchema = z.looseObject({
  context_length: z.number().int().positive().optional(),
  max_output_tokens: z.number().int().positive().optional(),
  reasoning_efforts: z.array(z.string()).optional(),
});
export type ModelProperties = z.infer<typeof ModelPropertiesSchema>;

export const ConfiguredModelSchema = z.looseObject({
  model_id: z.string().min(1),
  name: z.string().min(1),
  properties: ModelPropertiesSchema.optional(),
});
export type ConfiguredModel = z.infer<typeof ConfiguredModelSchema>;

export const ModelProviderTypeSchema = z.enum([
  "openai",
  "anthropic",
  "google-gemini",
  "fireworks",
  "zai",
  "moonshot",
  "together",
  "alibaba",
  "custom",
]);
export type ModelProviderType = z.infer<typeof ModelProviderTypeSchema>;

/**
 * The provider name is derived by the server from `type`; it is never
 * supplied on create. Responses redact `auth.api_key`.
 */
export const ModelProviderManifestSchema = z.looseObject({
  type: ModelProviderTypeSchema,
  auth: z.looseObject({ api_key: z.string() }),
  models: z.array(ConfiguredModelSchema),
  base_url: z.string().optional(),
});
export type ModelProviderManifest = z.infer<typeof ModelProviderManifestSchema>;

export const ConfiguredModelProviderSchema = z.looseObject({
  name: z.string().min(1),
  manifest: ModelProviderManifestSchema,
});
export type ConfiguredModelProvider = z.infer<typeof ConfiguredModelProviderSchema>;

export const AvailableModelSchema = z.looseObject({
  name: z.string().min(1),
  model_id: z.string().min(1),
  provider: z.looseObject({ name: z.string().min(1) }),
  properties: ModelPropertiesSchema.optional(),
});
export type AvailableModel = z.infer<typeof AvailableModelSchema>;

export const ResponseFormatSchema = z.union([
  z.looseObject({ type: z.literal("text") }),
  z.looseObject({ type: z.literal("json_object") }),
  z.looseObject({
    type: z.literal("json_schema"),
    json_schema: z.looseObject({
      name: z.string(),
      description: z.string().optional(),
      schema: z.record(z.string(), z.unknown()).optional(),
      strict: z.boolean().nullish(),
    }),
  }),
]);
export type ResponseFormat = z.infer<typeof ResponseFormatSchema>;

export const SkillRefSchema = z.object({ name: z.string().min(1).max(64) });
export type SkillRef = z.infer<typeof SkillRefSchema>;

export const McpServerRefSchema = z.looseObject({
  name: z.string().min(1),
  enable_tools: z.array(z.string()).optional(),
  disable_tools: z.array(z.string()).optional(),
  preload_tools: z.array(z.string()).optional(),
  require_approval_for_tools: z.array(z.string()).optional(),
  preload: z.boolean().optional(),
});
export type McpServerRef = z.infer<typeof McpServerRefSchema>;

export const RuntimeConfigSchema = z.looseObject({
  iteration_limit: z.number().int().positive().max(1024).optional(),
  sandbox: z
    .looseObject({ enabled: z.boolean(), file_downloads: z.boolean().optional() })
    .optional(),
  dynamic_sub_agents: z.looseObject({ enabled: z.boolean().optional() }).optional(),
  context_management: z
    .looseObject({
      compaction: z.looseObject({ enabled: z.boolean().optional() }).optional(),
      large_tool_response: z.looseObject({ enabled: z.boolean().optional() }).optional(),
    })
    .optional(),
  generative_ui: z.looseObject({ enabled: z.boolean().optional() }).optional(),
  ask_user_questions: z.looseObject({ enabled: z.boolean().optional() }).optional(),
});
export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;

export const AgentSpecSchema = z.looseObject({
  model: ModelRefSchema,
  instructions: z.string().optional(),
  messages: z
    .array(z.looseObject({ type: z.literal("user.message"), content: z.string() }))
    .optional(),
  mcp_servers: z.array(McpServerRefSchema).optional(),
  response_format: ResponseFormatSchema.optional(),
  skills: z.array(SkillRefSchema).optional(),
  config: RuntimeConfigSchema.optional(),
});
export type AgentSpec = z.infer<typeof AgentSpecSchema>;

export const AgentSchema = z.looseObject({
  id: z.string().min(1),
  name: z.string().min(1),
  manifest: AgentSpecSchema,
});
export type Agent = z.infer<typeof AgentSchema>;

export const SessionSchema = z.looseObject({
  id: z.string().min(1),
  agent: z.union([
    z.looseObject({
      type: z.literal("reference"),
      id: z.string().min(1),
      name: z.string().nullable(),
    }),
    z.looseObject({ type: z.literal("inline"), spec: AgentSpecSchema }),
  ]),
  title: z.string().nullish(),
  created_by: z.string().optional(),
  created_at: z.string(),
  updated_at: z.string().optional(),
});
export type Session = z.infer<typeof SessionSchema>;

export const ModelMessageUsageSchema = z.looseObject({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cache_read_tokens: z.number().int().nonnegative().optional(),
  cache_write_tokens: z.number().int().nonnegative().optional(),
  input_tokens_breakdown: z
    .looseObject({
      harness: z.number().int().nonnegative(),
      skills: z.number().int().nonnegative(),
      instructions: z.number().int().nonnegative(),
      tool_definitions: z.number().int().nonnegative(),
      messages: z.number().int().nonnegative(),
    })
    .optional(),
});
export type ModelMessageUsage = z.infer<typeof ModelMessageUsageSchema>;

const MessageContentPartSchema = z.looseObject({
  type: z.string(),
  text: z.string().optional(),
  refusal: z.string().nullish(),
});

export const ModelMessageEventSchema = z.looseObject({
  type: z.literal("model.message"),
  id: z.string(),
  thread_id: z.string(),
  created_at: z.string(),
  content: z.union([z.string(), z.array(MessageContentPartSchema), z.null()]).optional(),
  refusal: z.string().nullish(),
  reasoning_content: z.string().optional(),
  finish_reason: z.string().nullish(),
  usage: ModelMessageUsageSchema.optional(),
});
export type ModelMessageEvent = z.infer<typeof ModelMessageEventSchema>;

export const ToolCallRefSchema = z.looseObject({
  id: z.string(),
  source_event_id: z.string(),
});
export type ToolCallRef = z.infer<typeof ToolCallRefSchema>;

export const ToolApprovalRequiredEventSchema = z.looseObject({
  type: z.literal("tool.approval_required"),
  id: z.string(),
  created_at: z.string(),
  thread_id: z.string(),
  tool_calls: z.array(ToolCallRefSchema),
});
export type ToolApprovalRequiredEvent = z.infer<typeof ToolApprovalRequiredEventSchema>;

export const ToolResponseRequiredEventSchema = z.looseObject({
  type: z.literal("tool.response_required"),
  id: z.string(),
  created_at: z.string(),
  thread_id: z.string(),
  tool_calls: z.array(ToolCallRefSchema),
});
export type ToolResponseRequiredEvent = z.infer<typeof ToolResponseRequiredEventSchema>;

export const McpAuthRequiredEventSchema = z.looseObject({
  type: z.literal("mcp.auth_required"),
  id: z.string().optional(),
  created_at: z.string().optional(),
  thread_id: z.string().optional(),
  mcp_servers: z.array(z.looseObject({ name: z.string().optional() })).optional(),
});
export type McpAuthRequiredEvent = z.infer<typeof McpAuthRequiredEventSchema>;

export const ActionRequiredEventSchema = z.discriminatedUnion("type", [
  ToolApprovalRequiredEventSchema,
  ToolResponseRequiredEventSchema,
  McpAuthRequiredEventSchema,
]);
export type ActionRequiredEvent = z.infer<typeof ActionRequiredEventSchema>;

export const TurnMetricsSchema = z.looseObject({
  total_input_tokens: z.number().int().nonnegative().optional(),
  total_output_tokens: z.number().int().nonnegative().optional(),
  total_tokens: z.number().int().nonnegative().optional(),
  total_cache_read_tokens: z.number().int().nonnegative().optional(),
  total_cache_write_tokens: z.number().int().nonnegative().optional(),
  total_reasoning_tokens: z.number().int().nonnegative().optional(),
  total_cost_in_usd: z.number().nonnegative().optional(),
});
export type TurnMetrics = z.infer<typeof TurnMetricsSchema>;

export const TurnStateSchema = z.discriminatedUnion("status", [
  z.looseObject({ status: z.literal("running") }),
  z.looseObject({
    status: z.literal("done"),
    output: ModelMessageEventSchema.nullish(),
    required_actions: z.array(ActionRequiredEventSchema).default([]),
    completed_at: z.string().optional(),
    metrics: TurnMetricsSchema.optional(),
  }),
  z.looseObject({
    status: z.literal("cancelled"),
    reason: z.string().optional(),
    completed_at: z.string().optional(),
    metrics: TurnMetricsSchema.optional(),
  }),
  z.looseObject({
    status: z.literal("error"),
    message: z.string(),
    completed_at: z.string().optional(),
    metrics: TurnMetricsSchema.optional(),
  }),
]);
export type TurnState = z.infer<typeof TurnStateSchema>;

export const TurnSchema = z.looseObject({
  id: z.string().min(1),
  session_id: z.string().min(1),
  previous_turn_id: z.string().nullish(),
  input: z.array(z.unknown()).optional(),
  state: TurnStateSchema,
  created_at: z.string(),
});
export type Turn = z.infer<typeof TurnSchema>;

export const CapabilitiesSchema = z.looseObject({
  sandbox: z.looseObject({ enabled: z.boolean() }),
  skill: z.looseObject({ enabled: z.boolean(), reason: z.string().optional() }),
  settings: z.looseObject({ enabled: z.boolean() }),
});
export type Capabilities = z.infer<typeof CapabilitiesSchema>;

export const ConfiguredSkillSchema = z.looseObject({
  name: z.string().min(1),
  manifest: z.looseObject({
    type: z.string(),
    name: z.string(),
    url: z.string(),
    path: z.string().optional(),
    ref: z.string(),
    description: z.string(),
  }),
});
export type ConfiguredSkill = z.infer<typeof ConfiguredSkillSchema>;

/** Any event that arrives over the turn SSE stream. Kept loose on purpose. */
export const StreamEventSchema = z.looseObject({ type: z.string() });
export type StreamEvent = z.infer<typeof StreamEventSchema>;

const PaginationSchema = z.looseObject({
  limit: z.number().int().optional(),
  next_page_token: z.string().optional(),
  previous_page_token: z.string().optional(),
});

const ListAgentsResponseSchema = envelope(z.array(AgentSchema));
const GetAgentResponseSchema = envelope(AgentSchema);
const ListModelProvidersResponseSchema = envelope(z.array(ConfiguredModelProviderSchema));
const GetModelProviderResponseSchema = envelope(ConfiguredModelProviderSchema);
const ListModelsResponseSchema = envelope(z.array(AvailableModelSchema));
const ListSkillsResponseSchema = envelope(z.array(ConfiguredSkillSchema));
const GetCapabilitiesResponseSchema = envelope(CapabilitiesSchema);
const GetSessionResponseSchema = envelope(SessionSchema);
const ListSessionsResponseSchema = z.object({
  data: z.array(SessionSchema),
  pagination: PaginationSchema.optional(),
});
const GetTurnResponseSchema = envelope(TurnSchema);
const ListTurnsResponseSchema = z.object({
  data: z.array(TurnSchema),
  pagination: PaginationSchema.optional(),
});
const ListTurnEventsResponseSchema = z.object({
  data: z.array(StreamEventSchema),
  pagination: PaginationSchema.optional(),
});
const EmptyResponseSchema = z.looseObject({});

const RequestErrorSchema = z.object({
  error: z.looseObject({
    message: z.string(),
    type: z.string().optional(),
    code: z.string().nullish(),
    param: z.string().nullish(),
  }),
});

// ---------------------------------------------------------------------------
// Request payload types
// ---------------------------------------------------------------------------

/** A turn input item. `user.message` starts work; the other two resume it. */
export type TurnInputItem =
  | { type: "user.message"; content: string | Array<Record<string, unknown>> }
  | {
      type: "user.tool_approval";
      thread_id: string;
      tool_call_id: string;
      approval: { status: "allow" } | { status: "deny"; reason?: string };
    }
  | { type: "user.tool_response"; thread_id: string; tool_call_id: string; content: string };

export interface CreateTurnRequest {
  input: TurnInputItem[];
  /** `auto` chains to the session's last turn; `none` starts a new root turn. */
  previous_turn_id?: "auto" | "none" | (string & {});
  /** `false` returns the running turn immediately, which is what polling wants. */
  stream?: boolean;
}

/** Bind a session either to a saved agent by name, or to an inline spec. */
export type CreateSessionAgent = { name: string } | { spec: AgentSpec };

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type TrueForgeErrorKind = "http" | "network" | "timeout" | "validation" | "parse";

export interface TrueForgeErrorInit {
  kind: TrueForgeErrorKind;
  message: string;
  method: string;
  url: string;
  status?: number;
  code?: string | null;
  retryAfterMs?: number;
  body?: unknown;
  cause?: unknown;
}

/** The only error this module throws. Nothing raw from `fetch` escapes. */
export class TrueForgeError extends Error {
  readonly kind: TrueForgeErrorKind;
  readonly method: string;
  readonly url: string;
  readonly status?: number;
  readonly code?: string | null;
  readonly retryAfterMs?: number;
  readonly body?: unknown;

  constructor(init: TrueForgeErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "TrueForgeError";
    this.kind = init.kind;
    this.method = init.method;
    this.url = init.url;
    this.status = init.status;
    this.code = init.code;
    this.retryAfterMs = init.retryAfterMs;
    this.body = init.body;
  }

  /**
   * True when a retry could plausibly succeed: rate limits, gateway trouble,
   * and transport failures. Drives the backoff in `runAgentWithFallback`
   * (requirement A3.7).
   */
  get isRetryable(): boolean {
    if (this.kind === "network" || this.kind === "timeout") return true;
    if (this.kind !== "http" || this.status === undefined) return false;
    return this.status === 408 || this.status === 429 || this.status >= 500;
  }

  /** True for the two statuses the failure table calls out by name. */
  get isProviderOverload(): boolean {
    return this.kind === "http" && (this.status === 429 || this.status === 503);
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export const DEFAULT_TRUEFORGE_BASE_URL = "http://localhost:8790";

export interface TrueForgeClientOptions {
  /** Defaults to `TRUEFORGE_BASE_URL`, then `http://localhost:8790`. */
  baseUrl?: string;
  /** Defaults to `TRUEFORGE_API_KEY`. Empty means no header — auth is off locally. */
  apiKey?: string;
  /** Per-request timeout for control-plane calls. Default 30s. */
  timeoutMs?: number;
  /** Timeout for calls that start model work. Default 120s. */
  turnTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface RequestOptions<S extends z.ZodType> {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  schema: S;
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export class TrueForgeClient {
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly turnTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: TrueForgeClientOptions = {}) {
    const rawBase =
      options.baseUrl ?? process.env.TRUEFORGE_BASE_URL ?? DEFAULT_TRUEFORGE_BASE_URL;
    this.baseUrl = rawBase.replace(/\/+$/, "");
    this.apiKey = (options.apiKey ?? process.env.TRUEFORGE_API_KEY ?? "").trim();
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.turnTimeoutMs = options.turnTimeoutMs ?? 120_000;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (typeof this.fetchImpl !== "function") {
      throw new Error("TrueForgeClient requires a fetch implementation");
    }
  }

  // -- plumbing ------------------------------------------------------------

  private url(path: string, query?: Record<string, string | number | undefined>): string {
    const url = new URL(`${this.baseUrl}/api/v1${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = { accept: "application/json", ...extra };
    // Auth is disabled locally; sending an empty bearer would be rejected.
    if (this.apiKey.length > 0) headers.authorization = `Bearer ${this.apiKey}`;
    return headers;
  }

  /** `timeoutMs <= 0` means no timeout — used by the long-lived SSE subscription. */
  private async rawFetch(
    method: string,
    url: string,
    init: { body?: string; headers: Record<string, string>; timeoutMs: number; signal?: AbortSignal },
  ): Promise<Response> {
    const controller = new AbortController();
    // setTimeout overflows past 2^31-1 ms and fires immediately, so clamp.
    const delay = Math.min(init.timeoutMs, 2_147_483_647);
    const timer =
      delay > 0 ? setTimeout(() => controller.abort(new Error("timeout")), delay) : undefined;
    const onAbort = () => controller.abort(init.signal?.reason);
    init.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      return await this.fetchImpl(url, {
        method,
        headers: init.headers,
        body: init.body,
        signal: controller.signal,
      });
    } catch (cause) {
      if (init.signal?.aborted) {
        throw new TrueForgeError({
          kind: "network",
          message: `${method} ${url} was aborted by the caller`,
          method,
          url,
          cause,
        });
      }
      if (controller.signal.aborted) {
        throw new TrueForgeError({
          kind: "timeout",
          message: `${method} ${url} timed out after ${init.timeoutMs}ms`,
          method,
          url,
          cause,
        });
      }
      throw new TrueForgeError({
        kind: "network",
        message: `${method} ${url} failed to reach TrueForge at ${this.baseUrl}: ${describe(cause)}`,
        method,
        url,
        cause,
      });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      init.signal?.removeEventListener("abort", onAbort);
    }
  }

  private async request<S extends z.ZodType>(options: RequestOptions<S>): Promise<z.infer<S>> {
    const url = this.url(options.path, options.query);
    const hasBody = options.body !== undefined;
    const response = await this.rawFetch(options.method, url, {
      headers: this.headers(hasBody ? { "content-type": "application/json" } : undefined),
      body: hasBody ? JSON.stringify(options.body) : undefined,
      timeoutMs: options.timeoutMs ?? this.timeoutMs,
      signal: options.signal,
    });

    const text = await response.text().catch(() => "");
    let payload: unknown = undefined;
    if (text.length > 0) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }

    if (!response.ok) {
      const parsed = RequestErrorSchema.safeParse(payload);
      const detail = parsed.success ? parsed.data.error.message : truncate(text, 400);
      throw new TrueForgeError({
        kind: "http",
        message: `${options.method} ${options.path} failed with ${response.status}: ${detail || response.statusText}`,
        method: options.method,
        url,
        status: response.status,
        code: parsed.success ? (parsed.data.error.code ?? null) : null,
        retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
        body: payload,
      });
    }

    const result = options.schema.safeParse(payload ?? {});
    if (!result.success) {
      throw new TrueForgeError({
        kind: "validation",
        message: `${options.method} ${options.path} returned a payload that does not match the expected schema: ${formatIssues(result.error)}`,
        method: options.method,
        url,
        status: response.status,
        body: payload,
        cause: result.error,
      });
    }
    return result.data;
  }

  // -- capabilities, models, skills ---------------------------------------

  /** What this TrueForge can do right now — sandboxes, skills, settings. */
  async getCapabilities(signal?: AbortSignal): Promise<Capabilities> {
    const res = await this.request({
      method: "GET",
      path: "/capabilities",
      schema: GetCapabilitiesResponseSchema,
      signal,
    });
    return res.data;
  }

  /** Every model FQN available across all configured providers. */
  async listModels(signal?: AbortSignal): Promise<AvailableModel[]> {
    const res = await this.request({
      method: "GET",
      path: "/models",
      schema: ListModelsResponseSchema,
      signal,
    });
    return res.data;
  }

  async listSkills(signal?: AbortSignal): Promise<ConfiguredSkill[]> {
    const res = await this.request({
      method: "GET",
      path: "/settings/skills",
      schema: ListSkillsResponseSchema,
      signal,
    });
    return res.data;
  }

  // -- model providers -----------------------------------------------------

  async listModelProviders(signal?: AbortSignal): Promise<ConfiguredModelProvider[]> {
    const res = await this.request({
      method: "GET",
      path: "/settings/model-providers",
      schema: ListModelProvidersResponseSchema,
      signal,
    });
    return res.data;
  }

  /** The provider name is derived from `manifest.type`; do not supply one. */
  async createModelProvider(
    manifest: ModelProviderManifest,
    signal?: AbortSignal,
  ): Promise<ConfiguredModelProvider> {
    const res = await this.request({
      method: "POST",
      path: "/settings/model-providers",
      schema: GetModelProviderResponseSchema,
      body: { manifest },
      signal,
    });
    return res.data;
  }

  /** Replaces the manifest for the provider identified by `manifest.type`. */
  async updateModelProvider(
    manifest: ModelProviderManifest,
    signal?: AbortSignal,
  ): Promise<ConfiguredModelProvider> {
    const res = await this.request({
      method: "PUT",
      path: "/settings/model-providers",
      schema: GetModelProviderResponseSchema,
      body: { manifest },
      signal,
    });
    return res.data;
  }

  // -- agents --------------------------------------------------------------

  async listAgents(signal?: AbortSignal): Promise<Agent[]> {
    const res = await this.request({
      method: "GET",
      path: "/agents",
      schema: ListAgentsResponseSchema,
      signal,
    });
    return res.data;
  }

  async getAgent(agentId: string, signal?: AbortSignal): Promise<Agent> {
    const res = await this.request({
      method: "GET",
      path: `/agents/${encodeURIComponent(agentId)}`,
      schema: GetAgentResponseSchema,
      signal,
    });
    return res.data;
  }

  /** Look an agent up by its roster name. `null` when it has not been created. */
  async findAgentByName(name: string, signal?: AbortSignal): Promise<Agent | null> {
    const agents = await this.listAgents(signal);
    return agents.find((agent) => agent.name === name) ?? null;
  }

  async createAgent(name: string, manifest: AgentSpec, signal?: AbortSignal): Promise<Agent> {
    const res = await this.request({
      method: "POST",
      path: "/agents",
      schema: GetAgentResponseSchema,
      body: { name, manifest },
      signal,
    });
    return res.data;
  }

  async updateAgent(agentId: string, manifest: AgentSpec, signal?: AbortSignal): Promise<Agent> {
    const res = await this.request({
      method: "PUT",
      path: `/agents/${encodeURIComponent(agentId)}`,
      schema: GetAgentResponseSchema,
      body: { manifest },
      signal,
    });
    return res.data;
  }

  async deleteAgent(agentId: string, signal?: AbortSignal): Promise<void> {
    await this.request({
      method: "DELETE",
      path: `/agents/${encodeURIComponent(agentId)}`,
      schema: EmptyResponseSchema,
      signal,
    });
  }

  // -- sessions ------------------------------------------------------------

  /** `{ name }` binds a saved agent; `{ spec }` runs an inline manifest. */
  async createSession(agent: CreateSessionAgent, signal?: AbortSignal): Promise<Session> {
    const res = await this.request({
      method: "POST",
      path: "/sessions",
      schema: GetSessionResponseSchema,
      body: { agent },
      signal,
    });
    return res.data;
  }

  async getSession(sessionId: string, signal?: AbortSignal): Promise<Session> {
    const res = await this.request({
      method: "GET",
      path: `/sessions/${encodeURIComponent(sessionId)}`,
      schema: GetSessionResponseSchema,
      signal,
    });
    return res.data;
  }

  async listSessions(
    options: { limit?: number; agentId?: string; pageToken?: string } = {},
    signal?: AbortSignal,
  ): Promise<{ sessions: Session[]; nextPageToken?: string }> {
    const res = await this.request({
      method: "GET",
      path: "/sessions",
      schema: ListSessionsResponseSchema,
      query: {
        limit: options.limit,
        agent_id: options.agentId,
        page_token: options.pageToken,
      },
      signal,
    });
    return { sessions: res.data, nextPageToken: res.pagination?.next_page_token };
  }

  async deleteSession(sessionId: string, signal?: AbortSignal): Promise<void> {
    await this.request({
      method: "DELETE",
      path: `/sessions/${encodeURIComponent(sessionId)}`,
      schema: EmptyResponseSchema,
      signal,
    });
  }

  /** Stops whatever is running. Safe to call when nothing is. */
  async cancelSession(sessionId: string, signal?: AbortSignal): Promise<void> {
    await this.request({
      method: "POST",
      path: `/sessions/${encodeURIComponent(sessionId)}/cancel`,
      schema: EmptyResponseSchema,
      body: {},
      signal,
    });
  }

  // -- turns ---------------------------------------------------------------

  /**
   * Creates a turn. With `stream: false` (the default here) the running turn
   * comes back immediately and progress is read by polling `getTurn`.
   */
  async createTurn(
    sessionId: string,
    request: CreateTurnRequest,
    signal?: AbortSignal,
  ): Promise<Turn> {
    const res = await this.request({
      method: "POST",
      path: `/sessions/${encodeURIComponent(sessionId)}/turns`,
      schema: GetTurnResponseSchema,
      body: { stream: false, ...request },
      timeoutMs: this.turnTimeoutMs,
      signal,
    });
    return res.data;
  }

  /** Convenience for the common case: one user message, no streaming. */
  async sendMessage(sessionId: string, content: string, signal?: AbortSignal): Promise<Turn> {
    return this.createTurn(sessionId, {
      input: [{ type: "user.message", content }],
      stream: false,
    }, signal);
  }

  async getTurn(sessionId: string, turnId: string, signal?: AbortSignal): Promise<Turn> {
    const res = await this.request({
      method: "GET",
      path: `/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}`,
      schema: GetTurnResponseSchema,
      signal,
    });
    return res.data;
  }

  async listTurns(
    sessionId: string,
    options: { limit?: number; pageToken?: string } = {},
    signal?: AbortSignal,
  ): Promise<{ turns: Turn[]; nextPageToken?: string }> {
    const res = await this.request({
      method: "GET",
      path: `/sessions/${encodeURIComponent(sessionId)}/turns`,
      schema: ListTurnsResponseSchema,
      query: { limit: options.limit, page_token: options.pageToken },
      signal,
    });
    return { turns: res.data, nextPageToken: res.pagination?.next_page_token };
  }

  /**
   * Every event a turn emitted — sandbox creation, subagent threads, approvals,
   * skills. This is what makes harness activity legible in the run view (A13.9).
   */
  async listTurnEvents(
    sessionId: string,
    turnId: string,
    options: { limit?: number; order?: "asc" | "desc"; pageToken?: string } = {},
    signal?: AbortSignal,
  ): Promise<{ events: StreamEvent[]; nextPageToken?: string }> {
    const res = await this.request({
      method: "GET",
      path: `/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/events`,
      schema: ListTurnEventsResponseSchema,
      query: { limit: options.limit, order: options.order, page_token: options.pageToken },
      signal,
    });
    return { events: res.data, nextPageToken: res.pagination?.next_page_token };
  }

  /**
   * Subscribes to a running turn over SSE and yields each event as it arrives.
   * Use for the live timeline; use `getTurn` polling for the final result.
   */
  async *subscribeTurn(
    sessionId: string,
    turnId: string,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent, void, void> {
    const url = this.url(
      `/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/subscribe`,
    );
    const response = await this.rawFetch("GET", url, {
      headers: this.headers({ accept: "text/event-stream" }),
      // The stream stays open for the life of the turn; do not time it out.
      timeoutMs: 0,
      signal,
    });

    if (!response.ok || !response.body) {
      throw new TrueForgeError({
        kind: "http",
        message: `Could not subscribe to turn ${turnId}: ${response.status} ${response.statusText}`,
        method: "GET",
        url,
        status: response.status,
      });
    }

    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const event = parseSseFrame(frame);
          if (event) yield event;
          boundary = buffer.indexOf("\n\n");
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Pulls plain text out of a `model.message`, whatever content shape it used. */
export function messageText(message: ModelMessageEvent | null | undefined): string {
  if (!message) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part.text === "string" ? part.text : ""))
      .join("")
      .trim();
  }
  return "";
}

/** Every approval or tool-response request a finished turn is waiting on (A7). */
export function requiredActionsOf(turn: Turn): ActionRequiredEvent[] {
  return turn.state.status === "done" ? turn.state.required_actions : [];
}

/** True when the turn has stopped, whether it succeeded, failed or was cancelled. */
export function isTerminal(turn: Turn): boolean {
  return turn.state.status !== "running";
}

function parseSseFrame(frame: string): StreamEvent | null {
  const data = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data || data === "[DONE]") return null;
  try {
    const parsed = StreamEventSchema.safeParse(JSON.parse(data));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - Date.now());
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ");
}

function describe(cause: unknown): string {
  if (cause instanceof Error) {
    const code = (cause as NodeJS.ErrnoException).code;
    return code ? `${cause.message} (${code})` : cause.message;
  }
  return String(cause);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

let sharedClient: TrueForgeClient | null = null;

/** Process-wide client, configured from the environment. */
export function getTrueForgeClient(): TrueForgeClient {
  sharedClient ??= new TrueForgeClient();
  return sharedClient;
}

/** Test seam: drop the cached client so the next call rereads the environment. */
export function resetTrueForgeClient(): void {
  sharedClient = null;
}
