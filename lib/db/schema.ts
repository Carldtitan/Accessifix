/**
 * AccessiFix database schema.
 *
 * The findings ledger is the product (design principle 1): the baseline score,
 * the final score, the delta, the criterion matrix and every run view are all
 * queries over `findings`. Everything else in this file exists to give a
 * finding somewhere to point.
 *
 * Auth.js tables (`users`, `accounts`, `sessions`) keep the exact TypeScript
 * property names the Auth.js adapter contract expects (`providerAccountId`,
 * `access_token`, `sessionToken`, ...) so `@auth/drizzle-adapter` can be
 * dropped in later by handing it these tables. Postgres column names stay
 * snake_case like the rest of the schema.
 */
import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/* -------------------------------------------------------------------------- */
/* Shared column helpers                                                      */
/* -------------------------------------------------------------------------- */

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

const createdAt = () =>
  timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow();

const emptyJsonArray = sql`'[]'::jsonb`;

/* -------------------------------------------------------------------------- */
/* Enumerations                                                               */
/* -------------------------------------------------------------------------- */

export const RUN_PHASES = ['baseline', 'final'] as const;
export const RUN_STATUSES = [
  'queued',
  'crawling',
  'auditing',
  'fixing',
  'verifying',
  'awaiting_approval',
  'done',
  'failed',
] as const;
export const WCAG_LEVELS = ['A', 'AA'] as const;
export const VERDICTS = ['DECIDE', 'FLAG', 'BLOCKED'] as const;
export const FINDING_STATUSES = ['open', 'fixing', 'fixed', 'verified', 'dismissed'] as const;
export const SEVERITIES = ['critical', 'serious', 'moderate', 'minor'] as const;
/** The six audit lanes plus the two pipeline agents that can touch a finding. */
export const AGENT_NAMES = [
  'TREE',
  'VIS',
  'ACT',
  'PAGES',
  'MEDIA',
  'CODE',
  'FIX',
  'VERIFY',
] as const;
export const ARTIFACT_KINDS = ['screenshot', 'axtree', 'video', 'log'] as const;
export const PATCH_STATUSES = ['proposed', 'applied', 'verified', 'rejected'] as const;
export const HANDOFF_KINDS = ['approval', 'question'] as const;
export const HANDOFF_STATUSES = ['pending', 'approved', 'rejected', 'answered'] as const;

export const runPhaseEnum = pgEnum('run_phase', RUN_PHASES);
export const runStatusEnum = pgEnum('run_status', RUN_STATUSES);
export const wcagLevelEnum = pgEnum('wcag_level', WCAG_LEVELS);
export const verdictEnum = pgEnum('verdict', VERDICTS);
export const findingStatusEnum = pgEnum('finding_status', FINDING_STATUSES);
export const severityEnum = pgEnum('severity', SEVERITIES);
export const agentNameEnum = pgEnum('agent_name', AGENT_NAMES);
export const artifactKindEnum = pgEnum('artifact_kind', ARTIFACT_KINDS);
export const patchStatusEnum = pgEnum('patch_status', PATCH_STATUSES);
export const handoffKindEnum = pgEnum('handoff_kind', HANDOFF_KINDS);
export const handoffStatusEnum = pgEnum('handoff_status', HANDOFF_STATUSES);

export type RunPhase = (typeof RUN_PHASES)[number];
export type RunStatus = (typeof RUN_STATUSES)[number];
export type WcagLevel = (typeof WCAG_LEVELS)[number];
export type Verdict = (typeof VERDICTS)[number];
export type FindingStatus = (typeof FINDING_STATUSES)[number];
export type Severity = (typeof SEVERITIES)[number];
export type AgentName = (typeof AGENT_NAMES)[number];
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];
export type PatchStatus = (typeof PATCH_STATUSES)[number];
export type HandoffKind = (typeof HANDOFF_KINDS)[number];
export type HandoffStatus = (typeof HANDOFF_STATUSES)[number];

/* -------------------------------------------------------------------------- */
/* Auth.js tables (A1.1, A1.4)                                                */
/* -------------------------------------------------------------------------- */

export const users = pgTable('users', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text('name'),
  /**
   * Required. AccessiFix authenticates with the `user:email` scope, and the
   * Auth.js `AdapterUser` contract types `email` as a non-nullable string.
   */
  email: text('email').notNull().unique(),
  emailVerified: timestamp('email_verified', { withTimezone: true, mode: 'date' }),
  image: text('image'),
  createdAt: createdAt(),
});

export const accounts = pgTable(
  'accounts',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').$type<'oauth' | 'oidc' | 'email' | 'webauthn'>().notNull(),
    provider: text('provider').notNull(),
    providerAccountId: text('provider_account_id').notNull(),
    refresh_token: text('refresh_token'),
    /** The user's own GitHub token. A1.4 opens pull requests with it. */
    access_token: text('access_token'),
    expires_at: integer('expires_at'),
    token_type: text('token_type'),
    scope: text('scope'),
    id_token: text('id_token'),
    session_state: text('session_state'),
  },
  (t) => [
    primaryKey({ columns: [t.provider, t.providerAccountId] }),
    index('accounts_user_id_idx').on(t.userId),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    sessionToken: text('session_token').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expires: timestamp('expires', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (t) => [index('sessions_user_id_idx').on(t.userId)],
);

/* -------------------------------------------------------------------------- */
/* WCAG criteria reference (seeded from lib/db/criteria.ts)                   */
/* -------------------------------------------------------------------------- */

/**
 * A read-only mirror of `WCAG_CRITERIA`. The authoritative copy lives in code
 * so the application can validate a finding without a round trip; this table
 * exists so a report can left-join the fixed list of 55 in SQL (design, "The
 * Findings Ledger"). Populated by `npm run db:seed`.
 */
export const criteria = pgTable('criteria', {
  /** The WCAG number itself, e.g. `4.1.2`. */
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  level: wcagLevelEnum('level').notNull(),
  principle: text('principle').notNull(),
  plainEnglish: text('plain_english').notNull(),
  verdict: verdictEnum('verdict').notNull(),
  /** Primary audit lane. Null for the two BLOCKED criteria: no lane reaches them. */
  agent: agentNameEnum('agent'),
  /** Every lane the criterion needs, from the capability mapping. */
  capabilities: jsonb('capabilities').$type<AgentName[]>().notNull().default(emptyJsonArray),
  /** True for the 12 criteria observable only across a state transition. */
  stateDependent: boolean('state_dependent').notNull().default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

/* -------------------------------------------------------------------------- */
/* Targets and runs (A1, A2, A12)                                             */
/* -------------------------------------------------------------------------- */

export const targets = pgTable(
  'targets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** `owner/repo`. */
    repoFullName: text('repo_full_name').notNull(),
    deployedUrl: text('deployed_url').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('targets_user_id_idx').on(t.userId),
    uniqueIndex('targets_user_repo_url_key').on(t.userId, t.repoFullName, t.deployedUrl),
  ],
);

export const runs = pgTable(
  'runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'cascade' }),
    /** `baseline` before the fixes, `final` after. The A8 delta diffs the two. */
    phase: runPhaseEnum('phase').notNull(),
    status: runStatusEnum('status').notNull().default('queued'),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
    /** Sandbox budget. Never derive concurrency from `nproc` inside a sandbox. */
    maxSandboxes: integer('max_sandboxes').notNull().default(4),
    sandboxesUsed: integer('sandboxes_used').notNull().default(0),
    /** Stated reason when `status = 'failed'` (A2.3, design "Failure Handling"). */
    failureReason: text('failure_reason'),
    createdAt: createdAt(),
  },
  (t) => [index('runs_target_id_idx').on(t.targetId), index('runs_status_idx').on(t.status)],
);

export const pages = pgTable(
  'pages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    title: text('title'),
    crawledAt: timestamp('crawled_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    index('pages_run_id_idx').on(t.runId),
    uniqueIndex('pages_run_url_key').on(t.runId, t.url),
  ],
);

/* -------------------------------------------------------------------------- */
/* Patches (A5). Declared before findings so findings.fixId can reference it. */
/* -------------------------------------------------------------------------- */

export const patches = pgTable(
  'patches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    /** A5.2: patches are batched per source file, not per finding. */
    filePath: text('file_path').notNull(),
    diff: text('diff').notNull(),
    /** A5.5: which findings this patch addresses. */
    findingIds: jsonb('finding_ids').$type<string[]>().notNull().default(emptyJsonArray),
    status: patchStatusEnum('status').notNull().default('proposed'),
    createdAt: createdAt(),
  },
  (t) => [
    index('patches_run_id_idx').on(t.runId),
    index('patches_run_file_idx').on(t.runId, t.filePath),
  ],
);

/* -------------------------------------------------------------------------- */
/* THE FINDINGS LEDGER                                                        */
/* -------------------------------------------------------------------------- */

export const findings = pgTable(
  'findings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    /** Denormalised from the run so the A8 delta is a single grouped query. */
    phase: runPhaseEnum('phase').notNull(),
    pageId: uuid('page_id').references(() => pages.id, { onDelete: 'set null' }),
    /** Kept alongside `pageId` so a finding survives a re-crawl. */
    pageUrl: text('page_url').notNull(),
    /**
     * Non-negotiable rule 3: no finding is emitted without a numbered WCAG
     * success criterion attached. NOT NULL plus the blank check below is the
     * database's half of that; `getCriterion()` in criteria.ts is the
     * application's half.
     */
    criterion: text('criterion').notNull(),
    level: wcagLevelEnum('level').notNull(),
    verdict: verdictEnum('verdict').notNull(),
    status: findingStatusEnum('status').notNull().default('open'),
    severity: severityEnum('severity').notNull(),
    agent: agentNameEnum('agent').notNull(),
    /** One sentence. */
    summary: text('summary').notNull(),
    detail: text('detail'),
    /** File and line, when known. Groups the FIX pass (A5.2). */
    sourcePath: text('source_path'),
    fixId: uuid('fix_id').references(() => patches.id, { onDelete: 'set null' }),
    /** A12.1: the TrueForge session that produced this row, so a run can resume. */
    sessionId: text('session_id'),
    createdAt: createdAt(),
  },
  (t) => [
    index('findings_run_phase_idx').on(t.runId, t.phase),
    index('findings_criterion_idx').on(t.criterion),
    index('findings_run_status_idx').on(t.runId, t.status),
    index('findings_run_criterion_idx').on(t.runId, t.criterion),
    index('findings_page_id_idx').on(t.pageId),
    index('findings_fix_id_idx').on(t.fixId),
    check('findings_criterion_not_blank', sql`length(btrim(${t.criterion})) > 0`),
  ],
);

/* -------------------------------------------------------------------------- */
/* Evidence (A9)                                                              */
/* -------------------------------------------------------------------------- */

export const artifacts = pgTable(
  'artifacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Null while an artifact is captured before the finding that cites it exists. */
    findingId: uuid('finding_id').references(() => findings.id, { onDelete: 'cascade' }),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    kind: artifactKindEnum('kind').notNull(),
    mimeType: text('mime_type').notNull(),
    /** Inline bytes for small evidence. A9.2: artifacts never enter model context. */
    data: bytea('data'),
    /** Sandbox or object-store path for anything large. */
    storagePath: text('storage_path'),
    createdAt: createdAt(),
  },
  (t) => [
    index('artifacts_finding_id_idx').on(t.findingId),
    index('artifacts_run_id_idx').on(t.runId),
    check('artifacts_payload_present', sql`${t.data} IS NOT NULL OR ${t.storagePath} IS NOT NULL`),
  ],
);

/* -------------------------------------------------------------------------- */
/* Human handoffs (A7)                                                        */
/* -------------------------------------------------------------------------- */

export const handoffs = pgTable(
  'handoffs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    kind: handoffKindEnum('kind').notNull(),
    /** A7.2/A7.3: what the agent intends to do, in prose, not a raw tool payload. */
    intent: text('intent').notNull(),
    reason: text('reason').notNull(),
    /** Artifact ids supporting the request. */
    evidenceIds: jsonb('evidence_ids').$type<string[]>().notNull().default(emptyJsonArray),
    status: handoffStatusEnum('status').notNull().default('pending'),
    response: text('response'),
    createdAt: createdAt(),
    respondedAt: timestamp('responded_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    index('handoffs_run_id_idx').on(t.runId),
    index('handoffs_run_status_idx').on(t.runId, t.status),
  ],
);

/* -------------------------------------------------------------------------- */
/* Relations                                                                  */
/* -------------------------------------------------------------------------- */

export const usersRelations = relations(users, ({ many }) => ({
  accounts: many(accounts),
  sessions: many(sessions),
  targets: many(targets),
}));

export const accountsRelations = relations(accounts, ({ one }) => ({
  user: one(users, { fields: [accounts.userId], references: [users.id] }),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
}));

export const targetsRelations = relations(targets, ({ one, many }) => ({
  user: one(users, { fields: [targets.userId], references: [users.id] }),
  runs: many(runs),
}));

export const runsRelations = relations(runs, ({ one, many }) => ({
  target: one(targets, { fields: [runs.targetId], references: [targets.id] }),
  pages: many(pages),
  findings: many(findings),
  artifacts: many(artifacts),
  patches: many(patches),
  handoffs: many(handoffs),
}));

export const pagesRelations = relations(pages, ({ one, many }) => ({
  run: one(runs, { fields: [pages.runId], references: [runs.id] }),
  findings: many(findings),
}));

export const findingsRelations = relations(findings, ({ one, many }) => ({
  run: one(runs, { fields: [findings.runId], references: [runs.id] }),
  page: one(pages, { fields: [findings.pageId], references: [pages.id] }),
  patch: one(patches, { fields: [findings.fixId], references: [patches.id] }),
  artifacts: many(artifacts),
}));

export const artifactsRelations = relations(artifacts, ({ one }) => ({
  finding: one(findings, { fields: [artifacts.findingId], references: [findings.id] }),
  run: one(runs, { fields: [artifacts.runId], references: [runs.id] }),
}));

export const patchesRelations = relations(patches, ({ one, many }) => ({
  run: one(runs, { fields: [patches.runId], references: [runs.id] }),
  findings: many(findings),
}));

export const handoffsRelations = relations(handoffs, ({ one }) => ({
  run: one(runs, { fields: [handoffs.runId], references: [runs.id] }),
}));

/* -------------------------------------------------------------------------- */
/* Row types                                                                  */
/* -------------------------------------------------------------------------- */

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type CriterionRow = typeof criteria.$inferSelect;
export type NewCriterionRow = typeof criteria.$inferInsert;
export type Target = typeof targets.$inferSelect;
export type NewTarget = typeof targets.$inferInsert;
export type Run = typeof runs.$inferSelect;
export type NewRun = typeof runs.$inferInsert;
export type Page = typeof pages.$inferSelect;
export type NewPage = typeof pages.$inferInsert;
export type Finding = typeof findings.$inferSelect;
export type NewFinding = typeof findings.$inferInsert;
export type Artifact = typeof artifacts.$inferSelect;
export type NewArtifact = typeof artifacts.$inferInsert;
export type Patch = typeof patches.$inferSelect;
export type NewPatch = typeof patches.$inferInsert;
export type Handoff = typeof handoffs.$inferSelect;
export type NewHandoff = typeof handoffs.$inferInsert;
