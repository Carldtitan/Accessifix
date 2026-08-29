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
  let highWater = afterId;

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
        if (event.id <= highWater) return;
        highWater = event.id;
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
       * here and flushed after it, in id order. `send` drops anything at or
       * below the high-water mark, so an event that appears in both the buffer
       * and the replay is written once.
       */
      const buffered: RunEventPayload[] = [];
      let replaying = true;

      cleanup.push(
        subscribeToRun(runId, (event) => {
          if (replaying) buffered.push(event);
          else send(event);
        }),
      );

      // 2. Replay. Everything the client missed, in order.
      try {
        for (const event of await readRunEvents(runId, { afterId })) send(event);
      } catch (error) {
        write(
          `event: error\ndata: ${JSON.stringify({
            error: 'Could not replay the run log.',
            reason: error instanceof Error ? error.message : String(error),
          })}\n\n`,
        );
      }

      // 3. Flush whatever landed while the replay was in flight.
      replaying = false;
      for (const event of buffered.sort((a, b) => a.id - b.id)) send(event);
      buffered.length = 0;

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

        for (const event of await readRunEvents(runId, { afterId: highWater })) send(event);

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
            for (const event of await readRunEvents(runId, { afterId: highWater })) send(event);
            await finishIfTerminal();
          } catch {
            // A transient database error must not kill the stream; the next
            // tick tries again.
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
