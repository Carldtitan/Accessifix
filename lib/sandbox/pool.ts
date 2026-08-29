/**
 * Concurrency governor for sandbox provisioning.
 *
 * The cap is a budget, not a guess. The Daytona account is Tier 2 (100 vCPU /
 * 200 GiB); a browser sandbox takes 2 vCPU, so the pool is CPU-bound at roughly
 * 50 concurrent browsers with one build sandbox held in reserve. The practical
 * default is 10 — see DEFAULT_MAX_CONCURRENT_SANDBOXES in ./config.
 *
 * Never size this from `nproc`: inside a Daytona sandbox `nproc` reports the
 * HOST's core count (64 observed), not the sandbox's configured cap.
 *
 * The queue depth is deliberately observable. A11.2 requires the run view to
 * show sandboxes in use against the cap, and A3.3 requires excess interaction
 * paths to queue rather than fail.
 */

import { DEFAULT_MAX_CONCURRENT_SANDBOXES } from './config';

export interface PoolStats {
  /** Permits currently held. */
  active: number;
  /** Callers parked in `acquire()` waiting for a permit. */
  queued: number;
  /** The configured ceiling. */
  cap: number;
}

/** Returned by `acquire()`. Calling it twice is a no-op, so it is safe in a finally block. */
export type PoolRelease = () => void;

export interface AcquireOptions {
  /** Abort a queued acquisition. An already-granted permit is unaffected. */
  signal?: AbortSignal;
  /**
   * Milliseconds to wait in the queue before giving up. Omit to wait forever —
   * queueing is the designed behaviour for excess paths, not a failure mode.
   */
  timeoutMs?: number;
}

export class SandboxPoolClosedError extends Error {
  constructor() {
    super('The sandbox pool is closed.');
    this.name = 'SandboxPoolClosedError';
  }
}

export class SandboxAcquireTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Timed out after ${timeoutMs}ms waiting for a sandbox permit.`);
    this.name = 'SandboxAcquireTimeoutError';
  }
}

interface Waiter {
  resolve: (release: PoolRelease) => void;
  reject: (error: Error) => void;
  settled: boolean;
  cleanup: () => void;
}

/**
 * A counting semaphore with an observable queue depth.
 *
 * `acquire()` resolves with a release function; `release()` is also exposed as a
 * method so callers that track permits themselves can use the plain pair.
 */
export class SandboxPool {
  private capValue: number;
  private activeValue = 0;
  private readonly waiters: Waiter[] = [];
  private readonly listeners = new Set<(stats: PoolStats) => void>();
  private closed = false;

  constructor(cap: number = DEFAULT_MAX_CONCURRENT_SANDBOXES) {
    this.capValue = Math.max(1, Math.floor(cap));
  }

  /** Current occupancy. This is what the summary bar renders (A11.2). */
  stats(): PoolStats {
    return { active: this.activeValue, queued: this.waiters.length, cap: this.capValue };
  }

  /** True when a permit is available right now. */
  get available(): number {
    return Math.max(0, this.capValue - this.activeValue);
  }

  /**
   * Take a permit, waiting in line if the cap is reached.
   *
   * Resolves with an idempotent release function so the common shape is:
   *   const release = await pool.acquire();
   *   try { ... } finally { release(); }
   */
  acquire(options: AcquireOptions = {}): Promise<PoolRelease> {
    if (this.closed) return Promise.reject(new SandboxPoolClosedError());

    if (options.signal?.aborted) {
      return Promise.reject(abortError(options.signal));
    }

    if (this.activeValue < this.capValue) {
      this.activeValue += 1;
      this.emit();
      return Promise.resolve(this.makeRelease());
    }

    return new Promise<PoolRelease>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        settled: false,
        cleanup: () => undefined,
      };

      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => this.settleWaiter(waiter, null, abortError(options.signal));

      waiter.cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
      };

      if (options.timeoutMs !== undefined) {
        timer = setTimeout(
          () => this.settleWaiter(waiter, null, new SandboxAcquireTimeoutError(options.timeoutMs!)),
          options.timeoutMs,
        );
      }
      options.signal?.addEventListener('abort', onAbort, { once: true });

      this.waiters.push(waiter);
      this.emit();
    });
  }

  /**
   * Hand a permit back.
   *
   * Prefer the release function returned by `acquire()`; this method exists
   * because the interface is specified as `acquire()` / `release()` and because
   * callers holding permits across module boundaries need it.
   */
  release(): void {
    if (this.activeValue === 0) return;
    this.activeValue -= 1;
    this.drain();
    this.emit();
  }

  /** Acquire, run, release. The permit is returned even if `fn` throws. */
  async run<T>(fn: () => Promise<T>, options: AcquireOptions = {}): Promise<T> {
    const release = await this.acquire(options);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * Run every task with at most `cap` in flight. Tasks beyond the cap queue;
   * none are dropped, which is what A3.3 requires of excess interaction paths.
   * Results come back in input order. A rejected task rejects the whole call
   * only after every other task has settled, so no permit is stranded.
   */
  async map<T, R>(items: readonly T[], fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
    const settled = await Promise.allSettled(
      items.map((item, index) => this.run(() => fn(item, index))),
    );
    const failure = settled.find((entry) => entry.status === 'rejected');
    if (failure && failure.status === 'rejected') throw failure.reason;
    return settled.map((entry) => (entry as PromiseFulfilledResult<R>).value);
  }

  /**
   * Raise or lower the ceiling mid-run. Lowering it never revokes a live permit;
   * it just stops new ones being granted until occupancy falls below the new cap.
   */
  setCap(cap: number): void {
    this.capValue = Math.max(1, Math.floor(cap));
    this.drain();
    this.emit();
  }

  /** Subscribe to occupancy changes. Returns an unsubscribe function. */
  subscribe(listener: (stats: PoolStats) => void): () => void {
    this.listeners.add(listener);
    listener(this.stats());
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Reject everything still queued and refuse new acquisitions. Live permits are untouched. */
  close(): void {
    this.closed = true;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      this.settleWaiter(waiter, null, new SandboxPoolClosedError());
    }
    this.emit();
  }

  private makeRelease(): PoolRelease {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release();
    };
  }

  private drain(): void {
    while (this.waiters.length > 0 && this.activeValue < this.capValue) {
      const waiter = this.waiters.shift()!;
      if (waiter.settled) continue;
      this.activeValue += 1;
      this.settleWaiter(waiter, this.makeRelease(), null);
    }
  }

  private settleWaiter(waiter: Waiter, release: PoolRelease | null, error: Error | null): void {
    if (waiter.settled) return;
    waiter.settled = true;
    waiter.cleanup();

    const index = this.waiters.indexOf(waiter);
    if (index !== -1) this.waiters.splice(index, 1);

    if (error) {
      waiter.reject(error);
      this.emit();
      return;
    }
    waiter.resolve(release!);
    this.emit();
  }

  private emit(): void {
    if (this.listeners.size === 0) return;
    const stats = this.stats();
    for (const listener of this.listeners) {
      try {
        listener(stats);
      } catch {
        // An observer must never break the governor.
      }
    }
  }
}

function abortError(signal: AbortSignal | undefined): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const error = new Error('The sandbox acquisition was aborted.');
  error.name = 'AbortError';
  return error;
}

/**
 * Process-wide governor. Every browser sandbox in a run should be taken through
 * this instance so the queue depth in the run view reflects reality.
 */
export const sandboxPool = new SandboxPool();
