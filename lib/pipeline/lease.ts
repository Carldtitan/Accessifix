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

export interface LeaseHandle {
  runId: string;
  owner: string;
  /** Stop renewing and drop the row. Safe to call twice. */
  release(): Promise<void>;
  /** Resolves when the lease is lost to another conductor. */
  readonly lost: Promise<void>;
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
      options.onLost?.(
        `The conductor lease on run ${runId} expired and was taken by another process.`,
      );
      signalLost();
    })();
  }, LEASE_RENEW_MS);

  // Never keep the process alive just to renew a lease.
  timer.unref?.();

  return {
    runId,
    owner,
    lost,
    async release() {
      if (released) return;
      released = true;
      clearInterval(timer);
      await releaseLease(runId, owner).catch(() => undefined);
    },
  };
}
