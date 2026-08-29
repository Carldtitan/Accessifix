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

export interface AnswerOutcome extends HandoffDecision {
  /**
   * True when *this* call is the one that recorded the decision.
   *
   * False means someone else answered first and the standing decision is what
   * is being returned. The caller must not act on its own `approved` value in
   * that case: two clicks that disagree would otherwise persist one answer and
   * forward the other to the harness.
   */
  applied: boolean;
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

/** Whether a stored handoff status means the request was granted. */
function decidedApproved(handoff: Handoff): boolean {
  return handoff.status === 'approved' || handoff.status === 'answered';
}

/**
 * Record a decision.
 *
 * Idempotent, and — the part that matters — *honest about who won*. The update
 * is conditional on the row still being `pending`, so of two concurrent
 * requests exactly one changes the row. The loser does not get to pretend
 * otherwise: it reloads the row, returns the decision that was actually
 * persisted, and reports `applied: false` so the caller emits no event, tells
 * no agent, and resumes nothing.
 *
 * Without that, two clicks that disagree would persist one answer and forward
 * the opposite one to TrueForge, and both callers would claim success.
 */
export async function answerHandoff(
  handoffId: string,
  approved: boolean,
  options: { response?: string | null; kind?: HandoffKind } = {},
): Promise<AnswerOutcome | null> {
  const existing = await loadHandoff(handoffId);
  if (!existing) return null;

  if (existing.status !== 'pending') {
    return {
      handoff: existing,
      approved: decidedApproved(existing),
      response: existing.response,
      applied: false,
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

  if (!updated) {
    // Someone answered between the read and the write. Their decision stands.
    const settled = (await loadHandoff(handoffId)) ?? existing;
    return {
      handoff: settled,
      approved: decidedApproved(settled),
      response: settled.response,
      applied: false,
    };
  }

  await emitEvent({
    runId: updated.runId,
    type: 'approval',
    capability: 'approval',
    summary: decidedApproved(updated)
      ? `Approved: ${updated.intent}`
      : `Rejected: ${updated.intent}`,
    detail: options.response ?? null,
    data: { handoffId: updated.id, status: updated.status, approved: decidedApproved(updated) },
  });

  return {
    handoff: updated,
    approved: decidedApproved(updated),
    response: updated.response,
    applied: true,
  };
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
        return { handoff: row, approved: decidedApproved(row), response: row.response };
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
