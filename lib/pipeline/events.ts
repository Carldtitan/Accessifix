/**
 * The run event log, and the in-process bus that fans it out to SSE clients.
 *
 * Two halves, deliberately:
 *
 *   1. **Durable.** Every event is written to `run_events` before anyone is
 *      told about it. A browser that reloads mid-run replays the log from its
 *      `Last-Event-ID` and misses nothing (A13.8).
 *   2. **Live.** Subscribers on the same Node process are notified in-memory,
 *      so the run view updates in milliseconds rather than at poll cadence
 *      (A11.1).
 *
 * The bus is process-local by design. The orchestrator runs in the same Node
 * process as the SSE route in the demo topology; a multi-instance deployment
 * degrades gracefully, because `streamRunEvents` falls back to tailing the
 * table when nothing arrives on the bus.
 */
import { and, asc, eq, gt } from 'drizzle-orm';

import { db } from '@/lib/db';

import {
  runEvents,
  type EventCapability,
  type EventType,
  type RunEvent,
} from './schema';

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export interface EmitEventInput {
  runId: string;
  type: EventType;
  summary: string;
  /** The agent that produced it. `APP` is the dispatcher. */
  agent?: string;
  capability?: EventCapability;
  detail?: string | null;
  data?: Record<string, unknown>;
}

/** The wire shape sent to the browser. Kept flat so the client needs no mapping. */
export interface RunEventPayload {
  id: number;
  runId: string;
  type: EventType;
  agent: string;
  capability: EventCapability | null;
  summary: string;
  detail: string | null;
  data: Record<string, unknown>;
  timestamp: string;
}

export type RunEventListener = (event: RunEventPayload) => void;

function toPayload(row: RunEvent): RunEventPayload {
  return {
    id: row.id,
    runId: row.runId,
    type: row.type,
    agent: row.agent,
    capability: row.capability ?? null,
    summary: row.summary,
    detail: row.detail ?? null,
    data: row.data ?? {},
    timestamp: row.createdAt.toISOString(),
  };
}

/* -------------------------------------------------------------------------- */
/* The bus                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Next.js reloads modules on every edit in development. Without a global cache
 * the orchestrator and the SSE route end up holding two different buses and no
 * event ever crosses between them.
 */
const globalForBus = globalThis as unknown as {
  accessifixEventBus?: Map<string, Set<RunEventListener>>;
};

const listeners: Map<string, Set<RunEventListener>> =
  globalForBus.accessifixEventBus ?? new Map();

if (process.env.NODE_ENV !== 'production') {
  globalForBus.accessifixEventBus = listeners;
}

/** Listen to one run's events. Returns an unsubscribe function. */
export function subscribeToRun(runId: string, listener: RunEventListener): () => void {
  const set = listeners.get(runId) ?? new Set<RunEventListener>();
  set.add(listener);
  listeners.set(runId, set);

  return () => {
    const current = listeners.get(runId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) listeners.delete(runId);
  };
}

/** How many live SSE clients are attached to a run. Used by the orchestrator's logs. */
export function subscriberCount(runId: string): number {
  return listeners.get(runId)?.size ?? 0;
}

function publish(payload: RunEventPayload): void {
  const set = listeners.get(payload.runId);
  if (!set) return;
  for (const listener of set) {
    try {
      listener(payload);
    } catch {
      // A broken client must never break the pipeline.
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Writing                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Append one event, then notify live subscribers.
 *
 * Never throws. The pipeline must not die because the event log is briefly
 * unreachable — losing a timeline entry is survivable, losing a run is not.
 */
export async function emitEvent(input: EmitEventInput): Promise<RunEventPayload | null> {
  try {
    const [row] = await db
      .insert(runEvents)
      .values({
        runId: input.runId,
        type: input.type,
        agent: input.agent ?? 'APP',
        capability: input.capability ?? null,
        summary: input.summary.slice(0, 400),
        detail: input.detail ?? null,
        data: input.data ?? {},
      })
      .returning();

    if (!row) return null;
    const payload = toPayload(row);
    publish(payload);
    return payload;
  } catch (error) {
    console.error('[pipeline] failed to record run event', input.summary, error);
    return null;
  }
}

/** Fire-and-forget form, for hot paths where awaiting the log would serialise work. */
export function emitEventAsync(input: EmitEventInput): void {
  void emitEvent(input);
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Every event for a run after `afterId`. This is the replay half of the SSE
 * contract, and also what the run view's timeline renders on first paint.
 */
export async function readRunEvents(
  runId: string,
  options: { afterId?: number; limit?: number } = {},
): Promise<RunEventPayload[]> {
  const afterId = options.afterId ?? 0;
  const limit = Math.min(Math.max(options.limit ?? 500, 1), 2000);

  const rows = await db
    .select()
    .from(runEvents)
    .where(
      afterId > 0
        ? and(eq(runEvents.runId, runId), gt(runEvents.id, afterId))
        : eq(runEvents.runId, runId),
    )
    .orderBy(asc(runEvents.id))
    .limit(limit);

  return rows.map(toPayload);
}

/**
 * The last state-transition event, which is how a resumed run learns which
 * state it was paused from — `awaiting_approval` is an overlay, not a
 * destination, so the state before it is the one to return to.
 */
export async function lastStateEvent(runId: string): Promise<RunEventPayload | null> {
  const rows = await db
    .select()
    .from(runEvents)
    .where(and(eq(runEvents.runId, runId), eq(runEvents.type, 'state')))
    .orderBy(asc(runEvents.id));

  const last = rows.at(-1);
  return last ? toPayload(last) : null;
}

/**
 * Walk the state history backwards for the most recent state that was not
 * `awaiting_approval`. That is where an answered handoff resumes from.
 */
export async function stateBeforePause(runId: string): Promise<string | null> {
  const rows = await db
    .select()
    .from(runEvents)
    .where(and(eq(runEvents.runId, runId), eq(runEvents.type, 'state')))
    .orderBy(asc(runEvents.id));

  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const to = rows[i].data?.to;
    if (typeof to === 'string' && to !== 'awaiting_approval') return to;
  }
  return null;
}
