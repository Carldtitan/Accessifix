/**
 * High-level helpers for running one agent job.
 *
 * The application owns the pipeline; TrueForge owns each job. This module is
 * the seam: create a session, send one turn, wait, validate the JSON, hand
 * back a typed result. Retry and fallback live here too, because the free
 * TrueFoundry tier has no gateway-level fallback — the app dispatches, so the
 * app retries (requirement A3.7).
 *
 * Session and turn ids are returned on every path so the caller can write them
 * to the ledger and resume later (A12.1).
 */

import type { z } from "zod";

import {
  TrueForgeError,
  getTrueForgeClient,
  isTerminal,
  messageText,
  requiredActionsOf,
  type ActionRequiredEvent,
  type AgentSpec,
  type ToolApprovalRequiredEvent,
  type ToolResponseRequiredEvent,
  type TrueForgeClient,
  type Turn,
  type TurnMetrics,
} from "./client";
import {
  AGENT_ROSTER,
  buildFallbackSpec,
  isAgentName,
  resolveModel,
  type AgentDefinition,
  type AgentName,
  type BuildAgentSpecOptions,
} from "./agents";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A saved agent's name, or an inline manifest for the fallback lane. */
export type AgentTarget = string | AgentSpec;

/**
 * A fallback that is only constructed if the primary lane actually fails.
 * Building it lazily means the happy path costs nothing, and it lets the
 * fallback be read back from the server rather than guessed at.
 */
export type FallbackFactory = () => AgentTarget | null | Promise<AgentTarget | null>;

export interface RunAgentOptions<T = unknown> {
  client?: TrueForgeClient;
  /** Validates the agent's JSON. Omit to get the raw text back untouched. */
  schema?: z.ZodType<T>;
  /** Reuse an existing session instead of creating one — resume, or multi-turn. */
  sessionId?: string;
  /** Chain to a specific prior turn. Defaults to the session's last turn. */
  previousTurnId?: "auto" | "none" | (string & {});
  /** Total time allowed for the turn to finish. Default 10 minutes. */
  timeoutMs?: number;
  /** First poll delay. Grows to `maxPollIntervalMs`. Default 1.5s. */
  pollIntervalMs?: number;
  maxPollIntervalMs?: number;
  signal?: AbortSignal;
}

export interface AgentRunResult<T = unknown> {
  readonly sessionId: string;
  readonly turnId: string;
  /** The agent's raw reply text, before validation. */
  readonly text: string;
  /** Parsed and validated output. `null` when no schema was given, or the turn paused. */
  readonly data: T | null;
  /** Approval or tool-response requests the turn is waiting on (A7). */
  readonly requiredActions: readonly ActionRequiredEvent[];
  /** True when `requiredActions` is non-empty — the run is paused, not finished. */
  readonly paused: boolean;
  readonly metrics?: TurnMetrics;
  /** Model FQN, or the agent name when the target was a saved agent. */
  readonly target: string;
  /** True when the primary lane failed and the fallback produced this result. */
  readonly usedFallback: boolean;
  readonly attempts: number;
}

export type AgentRunFailure =
  | "turn-error"
  | "turn-cancelled"
  | "timeout"
  | "invalid-json"
  | "schema-mismatch";

/** A job that ran but did not produce a usable answer. */
export class AgentRunError extends Error {
  readonly reason: AgentRunFailure;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly target: string;
  readonly retryable: boolean;
  readonly raw?: string;

  constructor(init: {
    reason: AgentRunFailure;
    message: string;
    sessionId: string;
    turnId?: string;
    target: string;
    retryable: boolean;
    raw?: string;
    cause?: unknown;
  }) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "AgentRunError";
    this.reason = init.reason;
    this.sessionId = init.sessionId;
    this.turnId = init.turnId;
    this.target = init.target;
    this.retryable = init.retryable;
    this.raw = init.raw;
  }
}

// ---------------------------------------------------------------------------
// runAgent
// ---------------------------------------------------------------------------

/**
 * Runs one prompt against one agent and waits for the answer.
 *
 * @param agent Saved agent name (`"vis"`), or an inline `AgentSpec`.
 * @param prompt The user message. Everything the agent needs, in one turn.
 */
export async function runAgent<T = unknown>(
  agent: AgentTarget,
  prompt: string,
  options: RunAgentOptions<T> = {},
): Promise<AgentRunResult<T>> {
  const client = options.client ?? getTrueForgeClient();
  const target = describeTarget(agent);

  const sessionId =
    options.sessionId ??
    (await client.createSession(
      typeof agent === "string" ? { name: agent } : { spec: agent },
      options.signal,
    )).id;

  const created = await client.createTurn(
    sessionId,
    {
      input: [{ type: "user.message", content: prompt }],
      stream: false,
      ...(options.previousTurnId ? { previous_turn_id: options.previousTurnId } : {}),
    },
    options.signal,
  );

  const turn = await waitForTurn(sessionId, created.id, { ...options, client });
  return finalise<T>(turn, { target, schema: options.schema, usedFallback: false, attempts: 1 });
}

/**
 * Polls a turn until it stops running. Exported so a resumed run can pick up a
 * turn recorded in the ledger without recreating it (A12.2).
 */
export async function waitForTurn(
  sessionId: string,
  turnId: string,
  options: Omit<RunAgentOptions, "schema" | "sessionId" | "previousTurnId"> = {},
): Promise<Turn> {
  const client = options.client ?? getTrueForgeClient();
  const deadline = Date.now() + (options.timeoutMs ?? 600_000);
  let interval = options.pollIntervalMs ?? 1_500;
  const maxInterval = options.maxPollIntervalMs ?? 8_000;

  for (;;) {
    const turn = await client.getTurn(sessionId, turnId, options.signal);
    if (isTerminal(turn)) return turn;

    if (Date.now() >= deadline) {
      throw new AgentRunError({
        reason: "timeout",
        message: `Turn ${turnId} was still running after ${options.timeoutMs ?? 600_000}ms`,
        sessionId,
        turnId,
        target: sessionId,
        retryable: true,
      });
    }

    await sleep(Math.min(interval, Math.max(0, deadline - Date.now())), options.signal);
    interval = Math.min(Math.round(interval * 1.4), maxInterval);
  }
}

function finalise<T>(
  turn: Turn,
  context: {
    target: string;
    schema?: z.ZodType<T>;
    usedFallback: boolean;
    attempts: number;
  },
): AgentRunResult<T> {
  const sessionId = turn.session_id;

  if (turn.state.status === "error") {
    throw new AgentRunError({
      reason: "turn-error",
      message: `${context.target} failed: ${turn.state.message}`,
      sessionId,
      turnId: turn.id,
      target: context.target,
      // Turn errors are provider-side far more often than prompt-side.
      retryable: true,
      raw: turn.state.message,
    });
  }

  if (turn.state.status === "cancelled") {
    throw new AgentRunError({
      reason: "turn-cancelled",
      message: `${context.target} was cancelled (${turn.state.reason ?? "unknown reason"})`,
      sessionId,
      turnId: turn.id,
      target: context.target,
      retryable: turn.state.reason === "server-execution-timeout",
    });
  }

  if (turn.state.status === "running") {
    throw new AgentRunError({
      reason: "timeout",
      message: `${context.target} is still running`,
      sessionId,
      turnId: turn.id,
      target: context.target,
      retryable: true,
    });
  }

  const requiredActions = requiredActionsOf(turn);
  const text = messageText(turn.state.output);
  const base = {
    sessionId,
    turnId: turn.id,
    text,
    requiredActions,
    paused: requiredActions.length > 0,
    metrics: turn.state.metrics,
    target: context.target,
    usedFallback: context.usedFallback,
    attempts: context.attempts,
  };

  // A paused turn has not answered yet. Hand the approval requests back and
  // let the caller decide; do not treat the missing JSON as a failure.
  if (!context.schema || requiredActions.length > 0) {
    return { ...base, data: null };
  }

  const json = extractJson(text);
  if (json === undefined) {
    throw new AgentRunError({
      reason: "invalid-json",
      message: `${context.target} did not return JSON. First 200 characters: ${text.slice(0, 200)}`,
      sessionId,
      turnId: turn.id,
      target: context.target,
      // A model that ignored `response_format` once will often comply on a retry.
      retryable: true,
      raw: text,
    });
  }

  const parsed = context.schema.safeParse(json);
  if (!parsed.success) {
    throw new AgentRunError({
      reason: "schema-mismatch",
      message: `${context.target} returned JSON that does not match the schema: ${formatIssues(parsed.error)}`,
      sessionId,
      turnId: turn.id,
      target: context.target,
      retryable: true,
      raw: text,
      cause: parsed.error,
    });
  }

  return { ...base, data: parsed.data };
}

// ---------------------------------------------------------------------------
// Retry and fallback (A3.7)
// ---------------------------------------------------------------------------

export interface FallbackOptions<T = unknown> extends RunAgentOptions<T> {
  /** Attempts against the primary before the fallback is used. Default 3. */
  attempts?: number;
  /** First backoff delay in ms. Doubles each attempt. Default 1000. */
  baseDelayMs?: number;
  /** Cap on the backoff delay. Default 20000. */
  maxDelayMs?: number;
  /** Called before each retry, for the run timeline. */
  onRetry?: (info: {
    attempt: number;
    delayMs: number;
    target: string;
    error: unknown;
  }) => void;
}

/**
 * Exponential backoff on the primary — honouring `Retry-After` when the
 * provider sends one — then the same agent on its second model.
 *
 * Non-retryable failures (a 400, a 404, an unknown agent) throw immediately
 * rather than burning the fallback on a bug.
 */
export async function runAgentWithFallback<T = unknown>(
  primary: AgentTarget,
  fallback: AgentTarget | null | FallbackFactory,
  prompt: string,
  options: FallbackOptions<T> = {},
): Promise<AgentRunResult<T>> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const baseDelay = options.baseDelayMs ?? 1_000;
  const maxDelay = options.maxDelayMs ?? 20_000;
  const target = describeTarget(primary);
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await runAgent<T>(primary, prompt, options);
      return { ...result, attempts: attempt };
    } catch (error) {
      lastError = error;
      if (!isRetryable(error)) throw error;
      if (attempt === attempts) break;

      const delay = Math.min(
        retryAfterOf(error) ?? baseDelay * 2 ** (attempt - 1),
        maxDelay,
      );
      options.onRetry?.({ attempt, delayMs: delay, target, error });
      await sleep(delay, options.signal);
    }
  }

  const resolved = typeof fallback === "function" ? await fallback() : fallback;
  if (!resolved) throw lastError;

  // A fresh session: the fallback model must not inherit a poisoned context.
  const result = await runAgent<T>(resolved, prompt, { ...options, sessionId: undefined });
  return { ...result, usedFallback: true, attempts: attempts + 1 };
}

/** What the server told us it can do, so the fallback is configured like the primary. */
export interface RosterRunOptions<T = unknown> extends FallbackOptions<T> {
  /** Model FQNs this TrueForge can serve, from `GET /models`. */
  availableModels?: readonly string[];
  /** Whether a sandbox provider is configured, from `GET /capabilities`. */
  sandboxAvailable?: boolean;
  /** Skill names configured on this TrueForge, from `GET /settings/skills`. */
  availableSkills?: readonly string[];
}

/**
 * The roster-aware form: looks the agent up by name, and builds its fallback
 * manifest — the same agent on its second model — automatically.
 *
 * The fallback must be the primary with a different model and nothing else.
 * Sandbox availability and mountable skills are the server's decision, not the
 * roster's, so rebuilding a manifest without them turns the fallback into a
 * different agent: ACT, FIX and VERIFY would ask for a sandbox that is not
 * configured, and every lane would drop the skills the primary had mounted.
 * That is a silent behaviour change on the one path where the result matters
 * most, so the fallback is taken from the saved agent's own manifest wherever
 * it can be read back, and only built locally as a last resort.
 */
export async function runRosterAgent<T = unknown>(
  name: AgentName,
  prompt: string,
  options: RosterRunOptions<T> = {},
): Promise<AgentRunResult<T>> {
  const definition = AGENT_ROSTER[name];
  const client = options.client ?? getTrueForgeClient();
  const specOptions: BuildAgentSpecOptions = {
    availableModels: options.availableModels,
    sandboxAvailable: options.sandboxAvailable,
    availableSkills: options.availableSkills,
  };
  return runAgentWithFallback<T>(
    name,
    () => resolveFallbackSpec(name, definition, client, specOptions, options.signal),
    prompt,
    options,
  );
}

/**
 * The saved agent's own manifest with the model swapped, so the retry differs
 * from the original call in exactly one field. Falls back to the locally built
 * manifest when the saved agent cannot be read — a fallback built from the
 * roster is still better than no fallback at all.
 */
async function resolveFallbackSpec(
  name: AgentName,
  definition: AgentDefinition,
  client: TrueForgeClient,
  specOptions: BuildAgentSpecOptions,
  signal?: AbortSignal,
): Promise<AgentSpec | null> {
  const local = buildFallbackSpec(definition, specOptions);
  // No second model, or the primary already resolved to it.
  if (!local) return null;

  try {
    const saved = (await client.listAgents(signal)).find((agent) => agent.name === name);
    if (saved) {
      return { ...saved.manifest, model: { ...saved.manifest.model, name: local.model.name } };
    }
  } catch {
    // The control plane could not tell us; use what the roster knows.
  }
  return local;
}

function isRetryable(error: unknown): boolean {
  if (error instanceof AgentRunError) return error.retryable;
  if (error instanceof TrueForgeError) return error.isRetryable;
  return false;
}

function retryAfterOf(error: unknown): number | undefined {
  return error instanceof TrueForgeError ? error.retryAfterMs : undefined;
}

// ---------------------------------------------------------------------------
// Human handoff (A7)
// ---------------------------------------------------------------------------

export interface PendingApproval {
  /** Which required-action event this came from. */
  readonly eventId: string;
  readonly threadId: string;
  readonly toolCallId: string;
  /** `approval` needs an allow/deny; `response` needs content from the client. */
  readonly kind: "approval" | "response";
  /** The `model.message` event that requested the call, for rendering the intent. */
  readonly sourceEventId: string;
  readonly createdAt: string;
}

/**
 * Everything a turn is waiting on. This is what the handoff queue renders:
 * what the agent intends to do, and the thread and tool call that identify it.
 */
export async function getRequiredActions(
  sessionId: string,
  turnId: string,
  options: { client?: TrueForgeClient; signal?: AbortSignal } = {},
): Promise<ActionRequiredEvent[]> {
  const client = options.client ?? getTrueForgeClient();
  const turn = await client.getTurn(sessionId, turnId, options.signal);
  return requiredActionsOf(turn);
}

/** Flattens required actions into one row per pending tool call. */
export function toPendingApprovals(
  actions: readonly ActionRequiredEvent[],
): PendingApproval[] {
  const pending: PendingApproval[] = [];
  for (const action of actions) {
    if (action.type !== "tool.approval_required" && action.type !== "tool.response_required") {
      continue;
    }
    const event = action as ToolApprovalRequiredEvent | ToolResponseRequiredEvent;
    for (const call of event.tool_calls) {
      pending.push({
        eventId: event.id,
        threadId: event.thread_id,
        toolCallId: call.id,
        kind: event.type === "tool.approval_required" ? "approval" : "response",
        sourceEventId: call.source_event_id,
        createdAt: event.created_at,
      });
    }
  }
  return pending;
}

export interface ApprovalTarget {
  readonly threadId: string;
  readonly toolCallId: string;
}

/**
 * Answers an approval gate. This is the write-class pause described in A7.1 —
 * pushing a branch, opening a pull request, touching a file — resumed by a
 * `user.tool_approval` input on a turn chained to the paused one.
 *
 * @param approved `false` denies. Supply `reason` so the agent is told why.
 */
export async function approveToolCall(
  sessionId: string,
  turnId: string,
  approval: ApprovalTarget,
  approved: boolean,
  options: { reason?: string; client?: TrueForgeClient; signal?: AbortSignal } = {},
): Promise<Turn> {
  const client = options.client ?? getTrueForgeClient();
  return client.createTurn(
    sessionId,
    {
      input: [
        {
          type: "user.tool_approval",
          thread_id: approval.threadId,
          tool_call_id: approval.toolCallId,
          approval: approved
            ? { status: "allow" }
            : { status: "deny", ...(options.reason ? { reason: options.reason } : {}) },
        },
      ],
      previous_turn_id: turnId,
      stream: false,
    },
    options.signal,
  );
}

/** Answers a client-side tool call the agent delegated back to the application. */
export async function sendToolResponse(
  sessionId: string,
  turnId: string,
  target: ApprovalTarget,
  content: string,
  options: { client?: TrueForgeClient; signal?: AbortSignal } = {},
): Promise<Turn> {
  const client = options.client ?? getTrueForgeClient();
  return client.createTurn(
    sessionId,
    {
      input: [
        {
          type: "user.tool_response",
          thread_id: target.threadId,
          tool_call_id: target.toolCallId,
          content,
        },
      ],
      previous_turn_id: turnId,
      stream: false,
    },
    options.signal,
  );
}

/**
 * Approves or denies, then waits for the resumed turn to finish — the common
 * shape after a human answers a handoff card.
 */
export async function approveAndWait<T = unknown>(
  sessionId: string,
  turnId: string,
  approval: ApprovalTarget,
  approved: boolean,
  options: RunAgentOptions<T> & { reason?: string } = {},
): Promise<AgentRunResult<T>> {
  const resumed = await approveToolCall(sessionId, turnId, approval, approved, options);
  const turn = await waitForTurn(sessionId, resumed.id, options);
  return finalise<T>(turn, {
    target: sessionId,
    schema: options.schema,
    usedFallback: false,
    attempts: 1,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function describeTarget(agent: AgentTarget): string {
  if (typeof agent === "string") {
    return isAgentName(agent)
      ? `${agent} (${resolveModel(AGENT_ROSTER[agent])})`
      : agent;
  }
  return `inline:${agent.model.name}`;
}

/**
 * `response_format` should give us a bare JSON object, but a model that wraps
 * it in a fence or a sentence has still done the work. Recover it rather than
 * throwing away a whole audit pass.
 */
function extractJson(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;

  const candidates: string[] = [trimmed];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) candidates.push(fenced[1].trim());

  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(trimmed.slice(first, last + 1));

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try the next shape
    }
  }
  return undefined;
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("aborted"));
    };
    if (signal?.aborted) {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
