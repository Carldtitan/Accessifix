/**
 * `/api/runs/{runId}/events` — the live run stream (A11.1, A11.3).
 *
 * Server-Sent Events rather than WebSockets: the traffic is one-directional,
 * SSE survives a proxy that would drop a socket upgrade, and `EventSource`
 * reconnects on its own and hands back `Last-Event-ID` while doing it. That
 * last part is the whole reason the event ids are a monotonic integer — a
 * browser reload replays exactly what it missed and nothing else (A13.8).
 *
 * Every event names the agent that produced it and the harness capability
 * behind it (A11.3, A13.9), so the timeline can attribute rather than narrate.
 */
import { NextResponse } from 'next/server';

import { readRunEvents, subscribeToRun, type RunEventPayload } from '@/lib/pipeline/events';
import { currentUser, NOT_FOUND, runForUser, UNAUTHORIZED } from '@/lib/pipeline/access';
import { isLeased } from '@/lib/pipeline/lease';
import { isRunning } from '@/lib/pipeline/orchestrate';
import { isTerminal, readState } from '@/lib/pipeline/state';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** A comment frame every 15s keeps proxies from closing an idle connection. */
const HEARTBEAT_MS = 15_000;

/**
 * The bus is process-local. When the conductor is in another process, this
 * catches up by re-reading the table. Cheap: it is an indexed range scan on
 * `(run_id, id)` that usually returns nothing.
 */
const POLL_MS = 3_000;

/**
 * How many live events are held while the durable replay is still failing.
 *
 * Overflow is safe rather than lossy: every event on the bus is also a row in
 * the table, and the replay cursor only advances over rows a successful read
 * returned - so anything dropped here is delivered by the next poll instead.
 * The cap exists so a database outage cannot grow this array without bound.
 */
const MAX_BUFFERED_EVENTS = 2_000;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
): Promise<Response> {
  const user = await currentUser();
  if (!user) return NextResponse.json(UNAUTHORIZED, { status: 401 });

  const { runId } = await params;

  const owned = await runForUser(runId, user.id);
  if (!owned) return NextResponse.json(NOT_FOUND, { status: 404 });

  const url = new URL(request.url);
  const lastEventHeader = request.headers.get('last-event-id');
  const since = Number(lastEventHeader ?? url.searchParams.get('since') ?? 0);
  const afterId = Number.isFinite(since) && since > 0 ? since : 0;

  const encoder = new TextEncoder();

  /**
   * How far the durable log has been read *contiguously*: every event at or
   * below this id has been delivered to this client.
   *
   * Only a successful `readRunEvents` advances it, and only over rows that read
   * actually returned - so a read that fails is retried from the same place
   * rather than skipped past. This is the replay cursor, and keeping it
   * separate from "what has been written" is the whole fix: a live event
   * arriving off the bus says nothing about how much of the log has been read,
   * and letting one advance the other punches a permanent hole in the timeline.
   */
  let replayedThrough = afterId;

  /**
   * Ids written *above* the contiguous cursor, so they are not written twice.
   *
   * A set rather than a second high-water mark, because delivery above the
   * cursor is not ordered: a live event from the bus and a row from another
   * process's poll can arrive either way round, and a threshold would silently
   * discard whichever came second. Pruned every time the cursor advances over
   * it, so it holds at most one poll interval's worth of ids.
   */
  const deliveredAbove = new Set<number>();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      /**
       * Teardown is a list rather than a set of named handles: the timers and
       * the bus subscription are created after `close()` is defined, and a
       * stream that leaks an interval leaks it for the life of the process.
       */
      const cleanup: Array<() => void> = [];

      const write = (chunk: string): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          close();
        }
      };

      const send = (event: RunEventPayload): void => {
        if (event.id <= replayedThrough || deliveredAbove.has(event.id)) return;
        deliveredAbove.add(event.id);
        write(
          `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        );
      };

      function close(): void {
        if (closed) return;
        closed = true;
        for (const teardown of cleanup.splice(0)) {
          try {
            teardown();
          } catch {
            // One failed teardown must not strand the others.
          }
        }
        try {
          controller.close();
        } catch {
          // Already closed by the client.
        }
      }

      request.signal.addEventListener('abort', close, { once: true });

      // Tell EventSource how long to wait before reconnecting.
      write('retry: 3000\n\n');

      /*
       * 1. Subscribe *before* replaying.
       *
       * The order used to be the other way round, and it left a window: an
       * event committed between the replay query and the subscription belonged
       * to neither, and was simply lost. The event that falls into that window
       * most often is the last one, because `transition()` writes `runs.status`
       * and *then* appends the state event - so a request arriving in between
       * read a terminal run, closed, and never delivered the `done` the client
       * was waiting for.
       *
       * Everything that arrives on the bus before the replay finishes is held
       * here and flushed after it, in id order - and only once the durable read
       * has actually succeeded. `send` skips anything already delivered, so an
       * event that appears in both the buffer and the replay is written once.
       */
      const buffered: RunEventPayload[] = [];
      let replaying = true;
      let replayErrorReported = false;

      cleanup.push(
        subscribeToRun(runId, (event) => {
          if (!replaying) {
            send(event);
            return;
          }
          if (buffered.length < MAX_BUFFERED_EVENTS) buffered.push(event);
        }),
      );

      /**
       * Read the durable log forward from the replay cursor, and release the
       * buffer once - and only once - that read has succeeded.
       *
       * The buffer is not flushed on a failed replay, and that is the point.
       * Flushing it would write live ids and drag `highWater` past history the
       * client never received; every later query would then start after those
       * ids and the missing rows would be unreachable for the life of the
       * connection - a permanent hole punched by one transient database error.
       * Holding the buffer instead costs latency, which a retry three seconds
       * later repays, and history is not skipped.
       *
       * Throws on a read failure. Callers decide whether that is worth
       * reporting; the cursor is untouched either way.
       */
      const drainDurable = async (): Promise<void> => {
        const rows = await readRunEvents(runId, { afterId: replayedThrough });

        // Written first, then the cursor moves over the whole batch at once:
        // `send` skips anything already delivered off the bus.
        for (const event of rows) send(event);

        for (const event of rows) {
          if (event.id > replayedThrough) replayedThrough = event.id;
        }
        for (const id of deliveredAbove) {
          if (id <= replayedThrough) deliveredAbove.delete(id);
        }

        if (!replaying) return;

        // 3. The log is caught up; live events may now go straight out.
        replaying = false;
        for (const event of buffered.sort((a, b) => a.id - b.id)) send(event);
        buffered.length = 0;
      };

      // 2. Replay. Everything the client missed, in order.
      try {
        await drainDurable();
      } catch (error) {
        replayErrorReported = true;
        write(
          `event: error\ndata: ${JSON.stringify({
            error: 'Could not replay the run log; retrying.',
            reason: error instanceof Error ? error.message : String(error),
          })}\n\n`,
        );
      }

      /**
       * Close the stream on a terminal run - but never before one last read.
       *
       * The state column moves before its event is appended, so "the run is
       * done" is knowable a moment earlier than "here is the event that says
       * so". Catching up first is what guarantees the client's last frame is
       * the terminal state event rather than a silent disconnect.
       *
       * `isRunning` is process-local; the lease is not. A conductor working
       * this run in another process still holds one, and the stream stays open
       * for it.
       */
      const finishIfTerminal = async (): Promise<boolean> => {
        const current = await readState(runId);
        if (!isTerminal(current.state)) return false;
        if (isRunning(runId) || (await isLeased(runId))) return false;

        /*
         * Never end a stream that still owes the client history. While
         * `replaying` is true the initial durable read has not succeeded, so
         * closing now would deliver an `end` frame over a gap - the exact
         * silent hole the split cursor exists to prevent. The connection stays
         * open and the poll keeps retrying until the log can be read.
         */
        await drainDurable();
        if (replaying) return false;

        write(
          `event: end\ndata: ${JSON.stringify({
            runId,
            state: current.state,
            reason: current.run.failureReason ?? null,
          })}\n\n`,
        );
        close();
        return true;
      };

      // 4. A terminal run has nothing more to say. Close rather than hold a
      //    connection open forever on a finished audit.
      const finished = await finishIfTerminal().catch(() => false);
      if (finished) return;

      // 5. Catch-up, for a conductor in another process, and the end condition.
      const poll = setInterval(() => {
        void (async () => {
          try {
            await drainDurable();
            await finishIfTerminal();
            replayErrorReported = false;
          } catch (error) {
            /*
             * A transient database error must not kill the stream; the next
             * tick tries again, and from the same cursor, so nothing is
             * skipped. Reported once per outage rather than every three
             * seconds - a client that saw the first frame does not need
             * twenty more saying the same thing.
             */
            if (!replayErrorReported) {
              replayErrorReported = true;
              write(
                `event: error\ndata: ${JSON.stringify({
                  error: 'Could not read the run log; retrying.',
                  reason: error instanceof Error ? error.message : String(error),
                })}\n\n`,
              );
            }
          }
        })();
      }, POLL_MS);
      cleanup.push(() => clearInterval(poll));

      const heartbeat = setInterval(() => write(': keep-alive\n\n'), HEARTBEAT_MS);
      cleanup.push(() => clearInterval(heartbeat));
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Nginx buffers SSE into uselessness without this.
      'x-accel-buffering': 'no',
    },
  });
}
