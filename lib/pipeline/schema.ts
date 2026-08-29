/**
 * Pipeline-owned tables.
 *
 * `lib/db/schema.ts` models the *product*: targets, runs, pages, the findings
 * ledger, artifacts, patches, handoffs. It does not model the *conductor* —
 * the unit-of-work rows the orchestrator resumes from, or the event log the
 * live run view streams. Those two tables live here because the pipeline owns
 * them, and because A12.1 and A11.1/A11.3 cannot be satisfied without them:
 *
 *   - `pipeline_jobs`  — one row per unit of work, each storing its TrueForge
 *                        `session_id` so a restart reattaches to a running
 *                        session rather than starting a new one (A12.1, A12.2).
 *   - `run_events`     — the append-only event log. The SSE stream replays it
 *                        on reconnect, so a browser reload loses nothing
 *                        (A11.1, A11.3, A13.8, A13.9).
 *
 * Both reference `runs` with `on delete cascade`, so they disappear with the
 * run they describe.
 *
 * NOTE FOR THE SCHEMA OWNER: `drizzle.config.ts` points `schema` at
 * `./lib/db/schema.ts` only. Change it to
 * `['./lib/db/schema.ts', './lib/pipeline/schema.ts']` before `npm run db:push`
 * or these two tables will never be created. Nothing else in `lib/db` needs to
 * change — Drizzle's `schema` option only feeds the relational query builder,
 * and every query here uses the core builder.
 */
import { sql } from 'drizzle-orm';
import {
  bigserial,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { handoffs, runs } from '@/lib/db/schema';

const createdAt = () =>
  timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow();

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The ordered phases of one run (design, "Runtime Flow"). `crawl` is phase 0;
 * `pr` is the last thing that happens before the final audit.
 *
 * Deliberately `text` columns rather than Postgres enums: these values change
 * as the pipeline is tuned, and an enum migration for a conductor-internal
 * label is not worth the ceremony. The findings ledger — the part that is the
 * product — keeps its enums.
 */
export const PIPELINE_PHASES = [
  'crawl',
  'tree',
  'paths',
  'vis',
  'act',
  'media',
  'pages',
  'code',
  'score',
  'fix',
  'verify',
  'pr',
  'final_audit',
] as const;
export type PipelinePhase = (typeof PIPELINE_PHASES)[number];

export const JOB_STATUSES = [
  'pending',
  'running',
  'awaiting_approval',
  'succeeded',
  'failed',
  'skipped',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** Which harness capability produced an event (A13.9). Mirrors `HarnessCapability`. */
export const EVENT_CAPABILITIES = [
  'sandbox',
  'subagent',
  'approval',
  'skill',
  'model',
  'ledger',
] as const;
export type EventCapability = (typeof EVENT_CAPABILITIES)[number];

export const EVENT_TYPES = [
  'state',
  'phase',
  'job',
  'finding',
  'rejected',
  'sandbox',
  'approval',
  'patch',
  'score',
  'log',
  'error',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/* -------------------------------------------------------------------------- */
/* Jobs (A12.1)                                                               */
/* -------------------------------------------------------------------------- */

export const pipelineJobs = pgTable(
  'pipeline_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    phase: text('phase').$type<PipelinePhase>().notNull(),
    /**
     * The unit of work inside the phase: a page URL for `tree`/`vis`/`act`, a
     * source path for `fix`, the literal phase name for singletons like
     * `crawl` and `score`. Unique per run and phase, which is what makes a
     * resume idempotent.
     */
    jobKey: text('job_key').notNull(),
    /** The audit lane, when one owns the job. `null` for application-side work. */
    agent: text('agent'),
    status: text('status').$type<JobStatus>().notNull().default('pending'),
    /**
     * A12.1. The TrueForge session this job ran in. A restart reattaches to it
     * with `waitForTurn(sessionId, turnId)` rather than paying for the turn
     * again. Null for jobs that never called a model — TREE is deterministic.
     */
    sessionId: text('session_id'),
    /** The turn inside that session, for reattach and for approval chaining. */
    turnId: text('turn_id'),
    /** Approval coordinates, when the job is paused on a write-class tool (A7.1). */
    threadId: text('thread_id'),
    toolCallId: text('tool_call_id'),
    /** The handoff card a human is answering for this job, when paused. */
    handoffId: uuid('handoff_id').references(() => handoffs.id, { onDelete: 'set null' }),
    attempts: integer('attempts').notNull().default(0),
    /** Stated reason on `failed` or `skipped` (design, "Failure Handling"). */
    error: text('error'),
    /** Small structured result. Anything large lives in the sandbox (A9.2, A13.7). */
    result: jsonb('result').$type<Record<string, unknown>>(),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
  },
  (t) => [
    index('pipeline_jobs_run_idx').on(t.runId),
    index('pipeline_jobs_run_status_idx').on(t.runId, t.status),
    index('pipeline_jobs_session_idx').on(t.sessionId),
    uniqueIndex('pipeline_jobs_run_phase_key').on(t.runId, t.phase, t.jobKey),
  ],
);

/* -------------------------------------------------------------------------- */
/* Event log (A11.1, A11.3, A13.9)                                            */
/* -------------------------------------------------------------------------- */

export const runEvents = pgTable(
  'run_events',
  {
    /**
     * A monotonic integer, not a UUID: the SSE stream sends it as the event id
     * so a reconnecting browser can hand back `Last-Event-ID` and get exactly
     * the events it missed.
     */
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    type: text('type').$type<EventType>().notNull(),
    /** The agent that produced the event. `APP` is the dispatcher itself (A11.3). */
    agent: text('agent').notNull().default('APP'),
    capability: text('capability').$type<EventCapability>(),
    summary: text('summary').notNull(),
    detail: text('detail'),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [index('run_events_run_id_idx').on(t.runId, t.id)],
);

export type PipelineJob = typeof pipelineJobs.$inferSelect;
export type NewPipelineJob = typeof pipelineJobs.$inferInsert;
export type RunEvent = typeof runEvents.$inferSelect;
export type NewRunEvent = typeof runEvents.$inferInsert;
