/**
 * Conductor exclusivity, held in the database rather than in memory.
 *
 * `orchestrate.ts` keeps a process-local map of in-flight runs. That is a fast
 * path, not a guarantee: it coordinates nothing across processes, and this
 * application runs in more than one whenever `next start` sits behind a load
 * balancer or a deploy overlaps the old instance with the new. Two conductors
 * over one run is not a cosmetic race — it is two crawls, two FIX passes, two
 * branches and two pull requests against a user's repository.
 *
 * The lease is one row per run, claimed with a single conditional upsert:
 *
 *     insert ... on conflict (run_id) do update ...
 *       where the existing lease has expired, or it is already ours
 *
 * Postgres settles the winner; the loser gets no row back and knows it lost.
 *
 * Expiry rather than release-only, because the failure this exists for is a
 * process that *dies* — it will not release anything. A conductor renews while
 * it works, and a lease that stops being renewed falls in on its own, which is
 * what lets the boot sweep (A12.2) pick a run up without a human deciding the
 * old process is really gone.
 */
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';

import { and, eq, lte, or, sql } from 'drizzle-orm';

import { db } from '@/lib/db';

import { runLeases, type RunLease } from './schema';

/**
 * How long a claim survives without a renewal.
 *
 * Long enough that a slow event loop does not lose a lease mid-phase, short
 * enough that a crashed process does not strand a run for minutes.
 */
export const LEASE_TTL_MS = 60_000;

/** Renewal cadence. A third of the TTL leaves room for two missed beats. */
export const LEASE_RENEW_MS = 20_000;

/**
 * Identifies this process. Stable for its lifetime, unique across restarts —
 * a recycled pid on the same host must not look like the previous owner.
 */
const globalForConductor = globalThis as unknown as { accessifixConductorId?: string };

export function conductorId(): string {
  if (!globalForConductor.accessifixConductorId) {
    globalForConductor.accessifixConductorId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  }
  return globalForConductor.accessifixConductorId;
}

export interface LeaseClaim {
  ok: boolean;
  owner: string;
  lease: RunLease | null;
  /** Prose. Surfaced to the caller when a claim is refused. */
  reason: string;
}

function expiry(): Date {
  return new Date(Date.now() + LEASE_TTL_MS);
}

/**
 * Take exclusive conductorship of a run, or report who has it.
 *
 * Re-entrant for the same owner: a process that already holds the lease renews
 * it rather than being refused, which is what makes a resume in the same
 * process work.
 */
export async function claimRun(runId: string, owner = conductorId()): Promise<LeaseClaim> {
  const now = new Date();

  const [row] = await db
    .insert(runLeases)
    .values({ runId, owner, expiresAt: expiry(), acquiredAt: now, renewedAt: now })
    .onConflictDoUpdate({
      target: runLeases.runId,
      set: { owner, expiresAt: expiry(), renewedAt: now },
      // The whole of the mutual exclusion: steal only a dead lease, or renew
      // one that is already ours.
      setWhere: or(lte(runLeases.expiresAt, sql`now()`), eq(runLeases.owner, owner)),
    })
    .returning();

  if (row) {
    return { ok: true, owner, lease: row, reason: `Run ${runId} is conducted by ${owner}.` };
  }

  const held = await loadLease(runId);
  return {
    ok: false,
    owner,
    lease: held,
    reason: held
      ? `Another conductor (${held.owner}) holds this run until ${held.expiresAt.toISOString()}.`
      : 'Another conductor holds this run.',
  };
}

/**
 * Push the expiry out. Returns false when the lease is gone or has been taken
 * by someone else — the caller must then stop working on the run.
 */
export async function renewLease(runId: string, owner = conductorId()): Promise<boolean> {
  const [row] = await db
    .update(runLeases)
    .set({ expiresAt: expiry(), renewedAt: new Date() })
    .where(and(eq(runLeases.runId, runId), eq(runLeases.owner, owner)))
    .returning({ runId: runLeases.runId });

  return Boolean(row);
}

/** Give the lease up. Only the holder can, so a late release cannot evict a successor. */
export async function releaseLease(runId: string, owner = conductorId()): Promise<void> {
  await db
    .delete(runLeases)
    .where(and(eq(runLeases.runId, runId), eq(runLeases.owner, owner)));
}

export async function loadLease(runId: string): Promise<RunLease | null> {
  const [row] = await db.select().from(runLeases).where(eq(runLeases.runId, runId)).limit(1);
  return row ?? null;
}

/** True when a live lease exists, whoever holds it. Used by the SSE end condition. */
export async function isLeased(runId: string): Promise<boolean> {
  const lease = await loadLease(runId);
  return Boolean(lease && lease.expiresAt.getTime() > Date.now());
}

/**
 * Thrown when a conductor discovers it no longer owns the run.
 *
 * A distinct type because losing a lease is an *ownership handoff*, not a
 * pipeline failure, and the two must not be handled alike. A conductor whose
 * lease expired while it was paused is looking at a run that a healthy
 * successor is now conducting; writing `failed` on it would kill somebody
 * else's working run. Modelled on `JobLockedError`, which the conductor already
 * treats as "stand down quietly".
 */
export class LeaseLostError extends Error {
  readonly runId: string;

  constructor(runId: string, message: string) {
    super(message);
    this.name = 'LeaseLostError';
    this.runId = runId;
  }
}

export interface LeaseHandle {
  runId: string;
  owner: string;
  /** Stop renewing and drop the row. Safe to call twice. */
  release(): Promise<void>;
  /**
   * Stop renewing but leave the row standing. Safe to call twice.
   *
   * For handing a claim over to something that is already holding it. Owner
   * identity is per *process*, not per handle, so two handles taken out in one
   * process name the same row - and `release` on either would delete a lease
   * the other is still conducting under, which reads to that conductor as
   * having lost the run. Detaching gives up the timer and keeps the ownership.
   */
  detach(): void;
  /** Resolves when the lease is lost to another conductor. */
  readonly lost: Promise<void>;
  /**
   * The reason this lease was lost, or `null` while it is still held.
   *
   * Synchronous on purpose. A `catch` block has to decide between "this run
   * failed" and "this run is no longer mine" without awaiting anything, and an
   * aborted operation can surface as any error at all - the abort reason only
   * propagates from the few APIs that accept a signal. This is the answer that
   * does not depend on which error came back.
   */
  readonly lostReason: string | null;
}

/**
 * Hold a lease for the life of a phase of work, renewing in the background.
 *
 * `onLost` fires when a renewal finds the lease gone — the process was paused
 * long enough for it to expire and someone else took the run. The conductor
 * aborts rather than carrying on beside a second one.
 */
export function holdLease(
  runId: string,
  options: { owner?: string; onLost?: (reason: string) => void } = {},
): LeaseHandle {
  const owner = options.owner ?? conductorId();

  let released = false;
  let lostReason: string | null = null;
  let signalLost: () => void = () => undefined;
  const lost = new Promise<void>((resolve) => {
    signalLost = resolve;
  });

  const timer = setInterval(() => {
    void (async () => {
      if (released) return;
      let held = false;
      try {
        held = await renewLease(runId, owner);
      } catch {
        // A transient database error is not proof the lease is gone. The next
        // beat tries again; the TTL is three beats wide for exactly this.
        return;
      }
      if (held) return;

      clearInterval(timer);
      released = true;
      lostReason = `The conductor lease on run ${runId} expired and was taken by another process.`;
      options.onLost?.(lostReason);
      signalLost();
    })();
  }, LEASE_RENEW_MS);

  // Never keep the process alive just to renew a lease.
  timer.unref?.();

  return {
    runId,
    owner,
    lost,
    get lostReason() {
      return lostReason;
    },
    detach() {
      if (released) return;
      released = true;
      clearInterval(timer);
    },
    async release() {
      /*
       * A lost lease is already gone and already belongs to someone else.
       * `releaseLease` is owner-scoped so it would delete nothing, but not
       * calling it at all is the clearer statement: this conductor has no row
       * left to give up.
       */
      if (released) return;
      released = true;
      clearInterval(timer);
      await releaseLease(runId, owner).catch(() => undefined);
    },
  };
}

/**
 * Confirm this process still owns the run, immediately before a durable or
 * external write.
 *
 * Renewal doubles as the check: `renewLease` updates only a row whose owner is
 * still us, so a `false` means the lease was taken. Aborting an
 * `AbortController` does not reach work that never accepted a signal, so this
 * is the guard that actually stops a displaced conductor from writing findings,
 * moving the run's state, or opening a second pull request beside its
 * successor.
 *
 * A database error is not proof of anything and does not stop the run: the
 * renewal loop is three beats wide for exactly that reason, and refusing to
 * proceed on a blip would turn a transient outage into a failed run.
 */
export async function assertLeaseHeld(lease: LeaseHandle | null | undefined, before: string): Promise<void> {
  if (!lease) return;

  if (lease.lostReason !== null) {
    throw new LeaseLostError(lease.runId, `${lease.lostReason} Stood down before ${before}.`);
  }

  let held: boolean;
  try {
    held = await renewLease(lease.runId, lease.owner);
  } catch {
    return;
  }

  if (!held) {
    throw new LeaseLostError(
      lease.runId,
      `The conductor lease on run ${lease.runId} is no longer held by ${lease.owner}; ` +
        `another process has taken this run. Stood down before ${before}.`,
    );
  }
}
