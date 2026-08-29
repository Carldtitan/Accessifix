/**
 * Human handoffs (A7).
 *
 * "Fail into a pause, not a crash." Every irreversible moment — pushing a
 * branch, opening a pull request, any write-class tool call — becomes a card a
 * human answers, and the run holds until they do.
 *
 * The hold has to survive a page reload, an application restart, and a
 * reconnect (A7.4). It therefore cannot be a promise held in memory: the
 * `handoffs` row *is* the wait. `awaitHandoff` polls that row, so a restarted
 * process re-enters the same wait and sees the same answer. The in-process
 * event bus is only an accelerator — it wakes the poll immediately when the
 * answer arrives in the same process.
 */
import { and, eq } from 'drizzle-orm';

import { db } from '@/lib/db';
import { handoffs, type Handoff, type HandoffKind } from '@/lib/db/schema';

import { emitEvent, subscribeToRun } from './events';

/** How often the wait re-reads the row. Low enough to feel instant on a demo. */
const POLL_INTERVAL_MS = 2_000;

/** After this long with no answer, the interface is reminded (A7.5). */
const REMINDER_AFTER_MS = 60_000;

export interface RaiseHandoffInput {
  runId: string;
  kind: HandoffKind;
  /** What the agent intends to do. Prose, never a raw tool payload (A7.3). */
  intent: string;
  /** Why it wants to. */
  reason: string;
  /** Artifact ids supporting the request (A7.2). */
  evidenceIds?: string[];
  agent?: string;
}

export interface HandoffDecision {
  handoff: Handoff;
  approved: boolean;
  /** The human's written response, when they gave one. */
  response: string | null;
}

/** Create the card. Does not move the run state — the caller owns that. */
export async function raiseHandoff(input: RaiseHandoffInput): Promise<Handoff> {
  const [row] = await db
    .insert(handoffs)
    .values({
      runId: input.runId,
      kind: input.kind,
      intent: input.intent,
      reason: input.reason,
      evidenceIds: input.evidenceIds ?? [],
      status: 'pending',
    })
    .returning();

  await emitEvent({
    runId: input.runId,
    type: 'approval',
    agent: input.agent ?? 'APP',
    capability: 'approval',
    summary: input.intent,
    detail: input.reason,
    data: {
      handoffId: row.id,
      kind: input.kind,
      evidenceIds: input.evidenceIds ?? [],
      status: 'pending',
    },
  });

  return row;
}

export async function loadHandoff(handoffId: string): Promise<Handoff | null> {
  const [row] = await db.select().from(handoffs).where(eq(handoffs.id, handoffId)).limit(1);
  return row ?? null;
}

export async function pendingHandoffs(runId: string): Promise<Handoff[]> {
  return db
    .select()
    .from(handoffs)
    .where(and(eq(handoffs.runId, runId), eq(handoffs.status, 'pending')));
}

/**
 * Record a decision. Idempotent: answering an already-answered handoff returns
 * the existing decision rather than overwriting it, so a double-click on the
 * approve button cannot approve twice.
 */
export async function answerHandoff(
  handoffId: string,
  approved: boolean,
  options: { response?: string | null; kind?: HandoffKind } = {},
): Promise<HandoffDecision | null> {
  const existing = await loadHandoff(handoffId);
  if (!existing) return null;

  if (existing.status !== 'pending') {
    return {
      handoff: existing,
      approved: existing.status === 'approved' || existing.status === 'answered',
      response: existing.response,
    };
  }

  const status =
    existing.kind === 'question' ? 'answered' : approved ? 'approved' : 'rejected';

  const [updated] = await db
    .update(handoffs)
    .set({
      status,
      response: options.response ?? null,
      respondedAt: new Date(),
    })
    .where(and(eq(handoffs.id, handoffId), eq(handoffs.status, 'pending')))
    .returning();

  const row = updated ?? existing;

  await emitEvent({
    runId: row.runId,
    type: 'approval',
    capability: 'approval',
    summary: approved ? `Approved: ${row.intent}` : `Rejected: ${row.intent}`,
    detail: options.response ?? null,
    data: { handoffId: row.id, status, approved },
  });

  return { handoff: row, approved, response: row.response };
}

export class HandoffAbortedError extends Error {
  constructor(handoffId: string) {
    super(`The wait on handoff ${handoffId} was aborted.`);
    this.name = 'HandoffAbortedError';
  }
}

/**
 * Block until a human answers.
 *
 * Polls the row rather than holding a promise, so a restarted process resumes
 * the same wait (A7.4). An unanswered handoff emits a reminder onto the
 * timeline every minute, which is what the interface surfaces (A7.5).
 */
export async function awaitHandoff(
  handoffId: string,
  options: { signal?: AbortSignal; pollIntervalMs?: number } = {},
): Promise<HandoffDecision> {
  const interval = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const started = Date.now();
  let lastReminder = started;

  const existing = await loadHandoff(handoffId);
  if (!existing) throw new Error(`Handoff ${handoffId} does not exist.`);

  // Wake the poll the moment an answer lands in this process.
  let wake: (() => void) | null = null;
  const unsubscribe = subscribeToRun(existing.runId, (event) => {
    if (event.type === 'approval' && event.data?.handoffId === handoffId) wake?.();
  });

  try {
    for (;;) {
      if (options.signal?.aborted) throw new HandoffAbortedError(handoffId);

      const row = await loadHandoff(handoffId);
      if (!row) throw new Error(`Handoff ${handoffId} disappeared while waiting.`);

      if (row.status !== 'pending') {
        return {
          handoff: row,
          approved: row.status === 'approved' || row.status === 'answered',
          response: row.response,
        };
      }

      if (Date.now() - lastReminder >= REMINDER_AFTER_MS) {
        lastReminder = Date.now();
        await emitEvent({
          runId: row.runId,
          type: 'approval',
          capability: 'approval',
          summary: `Still waiting on a decision: ${row.intent}`,
          detail: `Unanswered for ${Math.round((Date.now() - started) / 1000)}s.`,
          data: { handoffId: row.id, status: 'pending', reminder: true },
        });
      }

      await new Promise<void>((resolve) => {
        const timer = setTimeout(finish, interval);
        const onAbort = () => finish();
        wake = finish;
        options.signal?.addEventListener('abort', onAbort, { once: true });

        function finish(): void {
          clearTimeout(timer);
          options.signal?.removeEventListener('abort', onAbort);
          wake = null;
          resolve();
        }
      });
    }
  } finally {
    unsubscribe();
  }
}
