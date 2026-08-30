"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { AgentTimeline } from "./AgentTimeline";
import { ApprovalCard, type Approval } from "./ApprovalCard";
import { CriterionMatrix } from "./CriterionMatrix";
import { DiffStack } from "./DiffCard";
import { EnvironmentGrid } from "./EnvironmentGrid";
import { FindingsByCriterion } from "./FindingsByCriterion";
import { Icon } from "./Icon";
import { RunSummaryBar } from "./RunSummaryBar";
import { StatusLabel } from "./StatusLabel";
import {
  eventsToTimeline,
  findingsByLane,
  formatDuration,
  groupByCriterion,
  jobsToEnvironments,
  runElapsed,
  runIsTerminal,
  scoreToMatrixRows,
  toPatchCards,
  toRunSummary,
  type FindingWire,
  type FrameWire,
  type HandoffWire,
  type JobWire,
  type PatchWire,
  type RunEventWire,
  type RunScoreWire,
  type RunWire,
  type TargetWire,
} from "./run-data";

/* -------------------------------------------------------------------------- */
/* Props                                                                      */
/* -------------------------------------------------------------------------- */

export interface RunLiveViewProps {
  run: RunWire;
  target: TargetWire;
  score: RunScoreWire;
  finalScore: RunScoreWire | null;
  findings: FindingWire[];
  events: RunEventWire[];
  jobs: JobWire[];
  patches: PatchWire[];
  pendingHandoffs: HandoffWire[];
  pageCount: number;
  /**
   * The browser frames captured so far, as artifact references.
   *
   * References, never bytes. The grid renders `<img src="/api/artifacts/{id}">`
   * so a frame crosses the network once and then caches; carrying the PNG in
   * this prop would re-serialise megabytes into the page on every update.
   */
  frames: FrameWire[];
  activeModel?: string;
}

/** Every named SSE event the pipeline emits, plus the stream's own `end`. */
const EVENT_TYPES = [
  "state",
  "phase",
  "job",
  "finding",
  "rejected",
  "sandbox",
  "approval",
  "patch",
  "score",
  "log",
] as const;

type ConnectionState = "connecting" | "live" | "ended" | "lost";

const CONNECTION_TEXT: Record<ConnectionState, string> = {
  connecting: "Connecting to the run stream",
  live: "Live. Updating as the run reports.",
  ended: "The run has finished. The stream is closed.",
  lost: "The stream dropped. Reconnecting.",
};

/**
 * The sandbox occupancy the pipeline last reported.
 *
 * Fresher than `runs.sandboxes_used`, which is only written periodically, so
 * the meter tracks the fleet rather than the last checkpoint. Returns null when
 * no sandbox event has arrived, and the caller falls back to the column.
 */
function latestSandboxCounts(
  events: ReadonlyArray<RunEventWire>,
): { used: number; max: number } | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event.type !== "sandbox") continue;
    const active = event.data?.active;
    const cap = event.data?.cap;
    if (typeof active === "number" && typeof cap === "number") {
      return { used: active, max: cap };
    }
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* The view                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The run view. Requirement A11 lives here: live parallel environments, a
 * summary bar, the findings ledger grouped by criterion, proposed patches, the
 * criterion matrix across all 55, an attributed agent timeline and the approval
 * gate.
 *
 * Everything is real. The first paint is server-rendered from the ledger; from
 * there `/api/runs/{id}/events` pushes and this refetches. A field the ledger
 * does not hold is left out rather than filled in.
 *
 * Accessibility contract:
 * - Nothing here moves focus. New findings, new environments and a finished run
 *   all announce through polite live regions, so a screen reader user is told
 *   without being interrupted (A11.6 / WCAG 3.2.x).
 * - The connection state is text, not a spinner, and says what it means.
 * - The presentational components below keep their own contracts; this
 *   component only feeds them.
 */
export function RunLiveView(props: RunLiveViewProps) {
  const [run, setRun] = useState<RunWire>(props.run);
  const [score, setScore] = useState<RunScoreWire>(props.score);
  const [finalScore, setFinalScore] = useState<RunScoreWire | null>(props.finalScore);
  const [findings, setFindings] = useState<FindingWire[]>(props.findings);
  const [jobs, setJobs] = useState<JobWire[]>(props.jobs);
  const [patches, setPatches] = useState<PatchWire[]>(props.patches);
  const [handoffs, setHandoffs] = useState<HandoffWire[]>(props.pendingHandoffs);
  const [pageCount, setPageCount] = useState<number>(props.pageCount);
  const [frames, setFrames] = useState<FrameWire[]>(props.frames);
  const [events, setEvents] = useState<RunEventWire[]>(props.events);
  // Seeded rather than corrected in an effect: a run that was already finished
  // when the server rendered it is never "connecting", not even for a frame.
  const [connection, setConnection] = useState<ConnectionState>(() =>
    runIsTerminal(props.run.status) ? "ended" : "connecting",
  );
  const [refreshError, setRefreshError] = useState<string | null>(null);

  /**
   * Undefined on the server and on the first client render, so the two agree.
   * The ticker fills it in after mount; a clock cannot be server-rendered
   * without a hydration mismatch.
   */
  const [elapsed, setElapsed] = useState<string | undefined>(undefined);

  /**
   * A minute-resolution clock, used only for "waiting N for a decision".
   *
   * Deliberately not the one-second `elapsed` ticker: that string sits in no
   * live region, but the approval card's waiting note *is* a polite live
   * region, and recomputing it every second would make a screen reader
   * re-announce it every second. Once a minute is the most it can change.
   */
  const [waitClock, setWaitClock] = useState<number | null>(null);

  const runId = props.run.id;
  const terminal = runIsTerminal(run.status);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* ---------------------------------------------------------------------- */
  /* Refetch                                                                */
  /* ---------------------------------------------------------------------- */

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [detailResponse, findingsResponse] = await Promise.all([
        fetch(`/api/runs/${encodeURIComponent(runId)}?jobs=true`, { cache: "no-store" }),
        fetch(`/api/runs/${encodeURIComponent(runId)}/findings?limit=1000`, {
          cache: "no-store",
        }),
      ]);

      if (!detailResponse.ok) {
        throw new Error(
          detailResponse.status === 404
            ? "This run is no longer readable from this account."
            : `The run could not be read. The server answered ${detailResponse.status}.`,
        );
      }

      const detail = (await detailResponse.json()) as {
        run: RunWire;
        score: RunScoreWire;
        finalScore: RunScoreWire | null;
        patches: PatchWire[];
        pages: unknown[];
        frames?: FrameWire[];
        pendingHandoffs: HandoffWire[];
        jobs?: JobWire[];
      };

      setRun(detail.run);
      setScore(detail.score);
      setFinalScore(detail.finalScore ?? null);
      setPatches(detail.patches ?? []);
      setHandoffs(detail.pendingHandoffs ?? []);
      setPageCount(Array.isArray(detail.pages) ? detail.pages.length : 0);
      // Frames arrive as pages land, so a live run fills its cards in one by
      // one. An older server that does not send the field leaves what we have
      // standing rather than blanking every card that already has a frame.
      if (Array.isArray(detail.frames)) setFrames(detail.frames);
      if (detail.jobs) setJobs(detail.jobs);

      if (findingsResponse.ok) {
        const body = (await findingsResponse.json()) as { findings: FindingWire[] };
        setFindings(body.findings ?? []);
      }

      setRefreshError(null);
    } catch (cause) {
      setRefreshError(
        cause instanceof Error ? cause.message : "The run could not be read just now.",
      );
    }
  }, [runId]);

  /** Coalesce a burst of events into one refetch. */
  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      void refresh();
    }, 700);
  }, [refresh]);

  /* ---------------------------------------------------------------------- */
  /* The stream                                                             */
  /* ---------------------------------------------------------------------- */

  useEffect(() => {
    // A finished run has nothing more to say. Opening a stream to it would
    // connect, replay and close, which is noise rather than information. The
    // "ended" label is already the seeded initial state.
    if (runIsTerminal(props.run.status)) return;

    const source = new EventSource(`/api/runs/${encodeURIComponent(runId)}/events`);
    let closed = false;

    const onOpen = () => setConnection("live");

    const onRunEvent = (message: MessageEvent<string>) => {
      setConnection("live");
      let payload: RunEventWire | null = null;
      try {
        payload = JSON.parse(message.data) as RunEventWire;
      } catch {
        return;
      }
      if (!payload || typeof payload.id !== "number") return;

      setEvents((current) =>
        current.some((event) => event.id === payload.id)
          ? current
          : [...current, payload].sort((a, b) => a.id - b.id),
      );
      scheduleRefresh();
    };

    const onEnd = () => {
      closed = true;
      setConnection("ended");
      source.close();
      // One last read, so the closing frame and the rendered state agree.
      void refresh();
    };

    const onError = (event: Event) => {
      // The server sends a named `error` frame with a body; EventSource also
      // fires a bodyless `error` when the socket drops. Only the second is a
      // connection problem, and EventSource retries it on its own.
      const data = (event as MessageEvent<string>).data;
      if (typeof data === "string" && data.length > 0) return;
      if (!closed) setConnection("lost");
    };

    source.addEventListener("open", onOpen);
    source.addEventListener("end", onEnd as EventListener);
    source.addEventListener("error", onError);
    for (const type of EVENT_TYPES) {
      source.addEventListener(type, onRunEvent as EventListener);
    }

    return () => {
      closed = true;
      source.removeEventListener("open", onOpen);
      source.removeEventListener("end", onEnd as EventListener);
      source.removeEventListener("error", onError);
      for (const type of EVENT_TYPES) {
        source.removeEventListener(type, onRunEvent as EventListener);
      }
      source.close();
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, [runId, props.run.status, refresh, scheduleRefresh]);

  /* ---------------------------------------------------------------------- */
  /* Elapsed clock                                                          */
  /* ---------------------------------------------------------------------- */

  useEffect(() => {
    const tick = () => setElapsed(runElapsed(run, Date.now()));
    tick();
    if (runIsTerminal(run.status)) return;
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [run]);

  useEffect(() => {
    const tick = () => setWaitClock(Date.now());
    tick();
    const timer = setInterval(tick, 60_000);
    return () => clearInterval(timer);
  }, []);

  /* ---------------------------------------------------------------------- */
  /* Derived                                                                */
  /* ---------------------------------------------------------------------- */

  /*
   * Plain derivations, not `useMemo`.
   *
   * Every one of these is a map or a sort over at most a few hundred rows,
   * reached only after a network round trip has already resolved. The React
   * Compiler memoizes them; hand-written dependency arrays here bought nothing
   * and could not be kept correct as the shapes changed.
   */
  const sandboxes = latestSandboxCounts(events) ?? {
    used: run.sandboxesUsed,
    max: run.maxSandboxes,
  };

  const summary = toRunSummary(
    { ...run, sandboxesUsed: sandboxes.used, maxSandboxes: sandboxes.max },
    {
      ...(props.activeModel ? { activeModel: props.activeModel } : {}),
      ...(elapsed ? { elapsed } : {}),
    },
  );

  const environments = jobsToEnvironments(jobs, findingsByLane(findings), frames);
  const groups = groupByCriterion(findings);
  const matrixRows = scoreToMatrixRows(score, finalScore);
  const timeline = eventsToTimeline(events);
  const patchCards = toPatchCards(patches, findings);

  const approvals: Approval[] = handoffs.map((handoff) => ({
    id: handoff.id,
    title:
      handoff.kind === "approval" ? "Approve a write-class action" : "The agent has a question",
    intent: handoff.intent,
    reason: handoff.reason,
    evidence: [],
    ...(waitClock && handoff.createdAt
      ? {
          // Rounded down to the minute, so the card's polite live region
          // changes at most once a minute rather than on every tick.
          waitingFor: formatDuration(
            Math.floor((waitClock - new Date(handoff.createdAt).getTime()) / 60_000) * 60_000,
          ),
        }
      : {}),
  }));


  /* ---------------------------------------------------------------------- */
  /* Render                                                                 */
  /* ---------------------------------------------------------------------- */

  return (
    <>
      <h2 className="sr-only">Run summary</h2>
      <RunSummaryBar run={summary} />

      <p className="muted" style={{ marginTop: 10, fontSize: 13 }}>
        <StatusLabel value={terminal ? "done" : "live"} /> {CONNECTION_TEXT[connection]}{" "}
        {pageCount > 0 ? `${pageCount} page${pageCount === 1 ? "" : "s"} crawled.` : null}
      </p>
      {/*
        The connection state and the ledger total. The environment counts are
        deliberately NOT repeated here: EnvironmentGrid announces those through
        its own polite region, and two regions saying the same thing is two
        announcements for one change.
      */}
      <p className="sr-only" aria-live="polite">
        {CONNECTION_TEXT[connection]} {findings.length} finding
        {findings.length === 1 ? "" : "s"} recorded.
      </p>

      {run.status === "failed" ? (
        <section className="section" aria-labelledby="run-failed" style={{ marginTop: 18 }}>
          <div className="section-heading">
            <div>
              <span className="eyebrow">Stopped</span>
              <h2 id="run-failed">This run failed</h2>
              <p>
                {run.failureReason ??
                  "The run stopped without recording a reason. Everything it had already written is below and is still readable."}
              </p>
            </div>
          </div>
        </section>
      ) : null}

      {refreshError ? (
        <p className="approval-error" role="status" style={{ marginTop: 14 }}>
          <Icon name="warning" size={17} />
          <span>{refreshError} What is shown below is the last good read.</span>
        </p>
      ) : null}

      {approvals.length > 0 ? (
        <section className="section" aria-labelledby="handoff">
          <div className="section-heading">
            <div>
              <span className="eyebrow">Handoff</span>
              <h2 id="handoff">The agent is waiting for you</h2>
              <p>
                The run pauses before pushing a branch, before opening a pull request, and before
                any write-class tool call.
              </p>
            </div>
            <span className="section-count">{approvals.length}</span>
          </div>
          <div style={{ display: "grid", gap: 14 }}>
            {approvals.map((approval) => (
              <ApprovalCard key={approval.id} approval={approval} runId={runId} />
            ))}
          </div>
        </section>
      ) : null}

      <section className="section" aria-labelledby="environments">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Live</span>
            <h2 id="environments">Browser environments</h2>
            <p>
              One browser per thing being tested. They run at the same time.
            </p>
          </div>
          <span className="section-count">{environments.length}</span>
        </div>
        <EnvironmentGrid
          environments={environments}
          emptyMessage={
            terminal
              ? "This run recorded no environments. It finished before dispatching any, or it predates the job ledger."
              : "The conductor has not dispatched any work yet. Cards appear here as jobs are claimed."
          }
        />
      </section>

      <section className="section" aria-labelledby="run-findings">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Evidence</span>
            <h2 id="run-findings">Findings, by criterion</h2>
            <p>
              {findings.length} finding{findings.length === 1 ? "" : "s"} across {groups.length}{" "}
              criterion{groups.length === 1 ? "" : "s"}. No finding exists without a numbered
              success criterion behind it.
            </p>
          </div>
          <span className="section-count">{findings.length}</span>
        </div>
        <FindingsByCriterion
          groups={groups}
          headingLevel={3}
          emptyMessage={
            terminal
              ? "This run finished without recording a finding against any of the 55 criteria."
              : "Nothing recorded yet. Findings appear here the moment a lane writes one."
          }
        />
      </section>

      {patchCards.length > 0 ? (
        <section className="section" aria-labelledby="patches">
          <div className="section-heading">
            <div>
              <span className="eyebrow">Proposed</span>
              <h2 id="patches">Code changes</h2>
              <p>Patches are batched per source file and record the findings they address.</p>
            </div>
            <span className="section-count">{patchCards.length}</span>
          </div>
          <DiffStack patches={patchCards} />
        </section>
      ) : null}

      <section className="section" aria-labelledby="matrix">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Score</span>
            <h2 id="matrix">Criterion matrix</h2>
            <p>
              {score.failingCriteria} failing, {score.flaggedCriteria} flagged,{" "}
              {score.blockedCriteria} blocked, {score.passingCriteria} with nothing recorded
              against them. Scope is never reduced to a subset.
            </p>
          </div>
          <span className="section-count">{matrixRows.length}</span>
        </div>
        <CriterionMatrix rows={matrixRows} id="run-criterion-matrix" />
        <p className="muted" style={{ marginTop: 12, fontSize: 13 }}>
          {score.disclaimer}
        </p>
      </section>

      <section className="section" aria-labelledby="timeline">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Chronology</span>
            <h2 id="timeline">Agent timeline</h2>
            <p>What each agent did, in order.</p>
          </div>
          <span className="section-count">{timeline.length}</span>
        </div>
        <AgentTimeline
          events={timeline}
          emptyMessage="The run has not written an event yet. The log is append-only, so nothing is missing — there is nothing there."
        />
      </section>

      <p style={{ marginTop: 22 }}>
        <Link className="button secondary" href={`/app/runs`}>
          <Icon name="back" size={15} />
          All runs
        </Link>
      </p>
    </>
  );
}
