/**
 * The one door into the findings ledger.
 *
 * A13.6 is unambiguous: **agents do not write to the database.** They return
 * structured claims; the application validates every claim and persists the
 * ones that survive. This file is that validation. Nothing else in the
 * pipeline may insert into `findings`.
 *
 * What a claim has to survive:
 *
 *   1. **A real criterion.** `criterion` must be one of the 55 (`getCriterion`).
 *      An invented number is rejected — non-negotiable rule 3.
 *   2. **The canonical verdict.** A2.3 gives each criterion exactly one
 *      verdict, and it is a property of the criterion, not of the agent's mood.
 *      A disagreement is corrected and logged, never persisted as-is.
 *   3. **Not BLOCKED.** The two blocked criteria are reported as blocked with a
 *      reason (A2.4); no lane may claim to have audited them.
 *   4. **A lane that can see it.** An agent may only claim criteria its
 *      capability covers (A3.1, A13.2). VIS cannot file a 4.1.2 state finding.
 *   5. **Evidence.** Rule 8: a claim with no artifact is not a finding. At
 *      least one of a source location, a selector, or an attached artifact.
 *   6. **A page in this run.** `page_url` is resolved to a `pages` row so the
 *      run view can link it; the URL is kept either way, so a finding survives
 *      a re-crawl.
 *   7. **Not already recorded.** Same criterion, same page, same element, same
 *      phase is one finding, however many lanes noticed it.
 *
 * Rejections are not silent. Each one is written to the event log with its
 * reason, which is what makes the gate auditable rather than merely strict.
 */
import { and, eq, inArray } from 'drizzle-orm';

import {
  WCAG_CRITERIA,
  blockedReason,
  getCriterion,
  type AuditAgent,
} from '@/lib/db/criteria';
import { db } from '@/lib/db';
import {
  artifacts,
  findings,
  pages,
  AGENT_NAMES,
  ARTIFACT_KINDS,
  SEVERITIES,
  type AgentName,
  type ArtifactKind,
  type Finding,
  type RunPhase,
  type Severity,
} from '@/lib/db/schema';

import { emitEvent } from './events';

/* -------------------------------------------------------------------------- */
/* Claim shape                                                                */
/* -------------------------------------------------------------------------- */

/**
 * A piece of evidence to store alongside the finding (A9.1).
 *
 * `data` is base64 for small things — an accessibility tree excerpt, a cropped
 * screenshot. Anything large stays in the sandbox and is referenced by
 * `storagePath` instead, because artifacts must never enter model context
 * (A9.2, A13.7).
 */
export interface FindingEvidence {
  kind: ArtifactKind;
  mimeType?: string;
  /** Base64 payload for inline evidence. */
  data?: string | null;
  /** Sandbox or object-store path for anything large. */
  storagePath?: string | null;
}

/**
 * What an audit lane hands back. Field-for-field compatible with the harness's
 * `FindingSchema` (`lib/harness/schemas.ts`) plus the routing context only the
 * application knows: which page, which lane, which TrueForge session.
 */
export interface FindingClaim {
  criterion: string;
  severity: Severity | string;
  summary: string;
  detail?: string | null;
  /** CSS selector for the offending element, when there is one. */
  selector?: string | null;
  /** Repository-relative path, with a line number when known. Groups FIX (A5.2). */
  sourcePath?: string | null;
  pageUrl: string;
  /** Overrides the batch page id when a lane spans pages (PAGES does). */
  pageId?: string | null;
  /** The lane's own verdict. Corrected to the canonical one when they differ. */
  verdict?: string | null;
  evidence?: FindingEvidence[];
}

export interface RecordFindingsInput {
  runId: string;
  phase: RunPhase;
  agent: AgentName;
  claims: readonly FindingClaim[];
  /** The TrueForge session that produced them (A12.1). Null for TREE. */
  sessionId?: string | null;
  /** Default page id for claims that do not carry one. */
  pageId?: string | null;
}

export interface RejectedClaim {
  claim: FindingClaim;
  reason: string;
}

export interface RecordFindingsResult {
  inserted: Finding[];
  rejected: RejectedClaim[];
  /** Claims that were already in the ledger for this run and phase. */
  duplicates: number;
  /** Claims whose verdict the application corrected to the canonical one. */
  corrected: number;
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

const AGENT_SET = new Set<string>(AGENT_NAMES);
const SEVERITY_SET = new Set<string>(SEVERITIES);
const ARTIFACT_KIND_SET = new Set<string>(ARTIFACT_KINDS);

/** Lanes that own criteria. FIX and VERIFY touch findings but do not claim them. */
const AUDIT_LANES = new Set<string>(['TREE', 'VIS', 'ACT', 'PAGES', 'MEDIA', 'CODE']);

const MAX_SUMMARY = 400;

interface ValidatedClaim {
  claim: FindingClaim;
  row: typeof findings.$inferInsert;
  evidence: FindingEvidence[];
  dedupeKey: string;
  corrected: boolean;
}

function dedupeKeyFor(
  phase: RunPhase,
  criterion: string,
  pageUrl: string,
  discriminator: string,
): string {
  return `${phase}|${criterion}|${pageUrl}|${discriminator}`.toLowerCase();
}

/**
 * Validate one claim in isolation. Returns the row to insert, or the reason it
 * cannot be inserted. No database access — this half is pure so it can be
 * reasoned about and tested without a connection.
 */
export function validateClaim(
  input: Omit<RecordFindingsInput, 'claims'>,
  claim: FindingClaim,
): { ok: true; value: ValidatedClaim } | { ok: false; reason: string } {
  if (!AGENT_SET.has(input.agent)) {
    return { ok: false, reason: `"${input.agent}" is not a known agent.` };
  }

  const criterionId = typeof claim.criterion === 'string' ? claim.criterion.trim() : '';
  if (!criterionId) {
    return { ok: false, reason: 'No WCAG success criterion attached (non-negotiable rule 3).' };
  }

  const criterion = getCriterion(criterionId);
  if (!criterion) {
    return {
      ok: false,
      reason: `"${criterionId}" is not one of the 55 WCAG 2.2 Level A/AA success criteria.`,
    };
  }

  if (criterion.verdict === 'BLOCKED') {
    return {
      ok: false,
      reason:
        `${criterion.id} is BLOCKED and cannot be audited. ` +
        'It is reported as blocked with a stated reason (A2.4), never as a finding.',
    };
  }

  // A3.1 / A13.2: a lane may only claim what its capability actually reaches.
  if (
    AUDIT_LANES.has(input.agent) &&
    !criterion.capabilities.includes(input.agent as AuditAgent)
  ) {
    return {
      ok: false,
      reason:
        `${input.agent} does not have the capability for ${criterion.id} ` +
        `(owned by ${criterion.agent ?? 'nobody'}).`,
    };
  }

  const summary = typeof claim.summary === 'string' ? claim.summary.trim() : '';
  if (!summary) {
    return { ok: false, reason: `${criterion.id}: no summary.` };
  }

  const severity = typeof claim.severity === 'string' ? claim.severity.trim() : '';
  if (!SEVERITY_SET.has(severity)) {
    return {
      ok: false,
      reason: `${criterion.id}: "${claim.severity}" is not a severity (${SEVERITIES.join(', ')}).`,
    };
  }

  const pageUrl = typeof claim.pageUrl === 'string' ? claim.pageUrl.trim() : '';
  if (!pageUrl) {
    return { ok: false, reason: `${criterion.id}: no page URL.` };
  }

  const evidence = (claim.evidence ?? []).filter(
    (item) =>
      item &&
      ARTIFACT_KIND_SET.has(item.kind) &&
      (typeof item.data === 'string' || typeof item.storagePath === 'string'),
  );

  const sourcePath = claim.sourcePath?.trim() || null;
  const selector = claim.selector?.trim() || null;
  const detail = claim.detail?.trim() || null;

  // Rule 8 / A9.1: a claim with no artifact is not a finding.
  if (evidence.length === 0 && !sourcePath && !selector) {
    return {
      ok: false,
      reason:
        `${criterion.id}: no evidence. A finding needs a screenshot, an ` +
        'accessibility tree excerpt, a source location, or at minimum the ' +
        'selector of the offending element (rule 8, A9.1).',
    };
  }

  // A2.3: the verdict belongs to the criterion, not to the agent.
  const corrected = Boolean(claim.verdict) && claim.verdict !== criterion.verdict;

  return {
    ok: true,
    value: {
      claim,
      corrected,
      evidence,
      dedupeKey: dedupeKeyFor(input.phase, criterion.id, pageUrl, selector ?? sourcePath ?? summary),
      row: {
        runId: input.runId,
        phase: input.phase,
        pageId: claim.pageId ?? input.pageId ?? null,
        pageUrl,
        criterion: criterion.id,
        level: criterion.level,
        verdict: criterion.verdict,
        status: 'open',
        severity: severity as Severity,
        agent: input.agent,
        summary: summary.slice(0, MAX_SUMMARY),
        detail:
          detail && selector && !detail.includes(selector)
            ? `${detail}\n\nSelector: ${selector}`
            : (detail ?? (selector ? `Selector: ${selector}` : null)),
        sourcePath,
        sessionId: input.sessionId ?? null,
      },
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Persistence                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Validate a batch of claims and persist the survivors.
 *
 * The **only** function in AccessiFix that inserts into `findings`. Every
 * audit lane, the FIX pass and the final re-audit all come through here.
 */
export async function recordFindings(
  input: RecordFindingsInput,
): Promise<RecordFindingsResult> {
  const result: RecordFindingsResult = {
    inserted: [],
    rejected: [],
    duplicates: 0,
    corrected: 0,
  };

  if (input.claims.length === 0) return result;

  const validated: ValidatedClaim[] = [];
  const seenInBatch = new Set<string>();

  for (const claim of input.claims) {
    const outcome = validateClaim(input, claim);
    if (!outcome.ok) {
      result.rejected.push({ claim, reason: outcome.reason });
      continue;
    }
    if (seenInBatch.has(outcome.value.dedupeKey)) {
      result.duplicates += 1;
      continue;
    }
    seenInBatch.add(outcome.value.dedupeKey);
    validated.push(outcome.value);
  }

  if (validated.length > 0) {
    // Resolve page ids for anything the lane did not carry one for.
    await attachPageIds(input.runId, validated);
    const fresh = await dropAlreadyRecorded(input.runId, input.phase, validated);
    result.duplicates += validated.length - fresh.length;

    if (fresh.length > 0) {
      const inserted = await db.transaction(async (tx) => {
        const rows = await tx
          .insert(findings)
          .values(fresh.map((item) => item.row))
          .returning();

        const evidenceRows = rows.flatMap((row, index) =>
          (fresh[index]?.evidence ?? []).map((item) => ({
            findingId: row.id,
            runId: input.runId,
            kind: item.kind,
            mimeType: item.mimeType ?? defaultMimeType(item.kind),
            data: item.data ? Buffer.from(item.data, 'base64') : null,
            storagePath: item.storagePath ?? null,
          })),
        );

        if (evidenceRows.length > 0) {
          await tx.insert(artifacts).values(evidenceRows);
        }
        return rows;
      });

      result.inserted = inserted;
      result.corrected = fresh.filter((item) => item.corrected).length;
    }
  }

  await announce(input, result);
  return result;
}

/** Resolve `page_url` to a `pages` row so the run view can link the finding. */
async function attachPageIds(runId: string, validated: ValidatedClaim[]): Promise<void> {
  const missing = validated.filter((item) => !item.row.pageId);
  if (missing.length === 0) return;

  const urls = [...new Set(missing.map((item) => item.row.pageUrl))];
  const rows = await db
    .select({ id: pages.id, url: pages.url })
    .from(pages)
    .where(and(eq(pages.runId, runId), inArray(pages.url, urls)));

  const byUrl = new Map(rows.map((row) => [row.url, row.id]));
  for (const item of missing) {
    item.row.pageId = byUrl.get(item.row.pageUrl) ?? null;
  }
}

/**
 * Drop claims already in the ledger for this run and phase.
 *
 * VIS and ACT run in parallel over overlapping criteria, and a resumed run
 * replays work it had already done. Both produce honest duplicates; neither
 * should double the finding count.
 */
async function dropAlreadyRecorded(
  runId: string,
  phase: RunPhase,
  validated: ValidatedClaim[],
): Promise<ValidatedClaim[]> {
  const criteria = [...new Set(validated.map((item) => item.row.criterion))];

  const existing = await db
    .select({
      criterion: findings.criterion,
      pageUrl: findings.pageUrl,
      summary: findings.summary,
      detail: findings.detail,
      sourcePath: findings.sourcePath,
    })
    .from(findings)
    .where(
      and(
        eq(findings.runId, runId),
        eq(findings.phase, phase),
        inArray(findings.criterion, criteria),
      ),
    );

  const seen = new Set<string>();
  for (const row of existing) {
    // The discriminator is recovered the same way it was built: selector first
    // (it is folded into `detail` on insert), then source path, then summary.
    const selector = extractSelector(row.detail);
    seen.add(dedupeKeyFor(phase, row.criterion, row.pageUrl, selector ?? row.sourcePath ?? row.summary));
  }

  return validated.filter((item) => !seen.has(item.dedupeKey));
}

const SELECTOR_LINE = /^Selector:\s*(.+)$/m;

function extractSelector(detail: string | null): string | null {
  if (!detail) return null;
  const match = SELECTOR_LINE.exec(detail);
  return match ? match[1].trim() : null;
}

function defaultMimeType(kind: ArtifactKind): string {
  switch (kind) {
    case 'screenshot':
      return 'image/png';
    case 'axtree':
      return 'application/json';
    case 'video':
      return 'video/webm';
    case 'log':
    default:
      return 'text/plain';
  }
}

/** Put the outcome on the timeline, including every rejection and its reason. */
async function announce(
  input: Omit<RecordFindingsInput, 'claims'>,
  result: RecordFindingsResult,
): Promise<void> {
  if (result.inserted.length > 0) {
    const byCriterion = new Map<string, number>();
    for (const row of result.inserted) {
      byCriterion.set(row.criterion, (byCriterion.get(row.criterion) ?? 0) + 1);
    }

    await emitEvent({
      runId: input.runId,
      type: 'finding',
      agent: input.agent,
      capability: 'ledger',
      summary: `${input.agent} recorded ${result.inserted.length} finding(s).`,
      detail: [...byCriterion.entries()].map(([id, n]) => `${id} x${n}`).join(', '),
      data: {
        phase: input.phase,
        criteria: Object.fromEntries(byCriterion),
        sessionId: input.sessionId ?? null,
      },
    });
  }

  if (result.corrected > 0) {
    await emitEvent({
      runId: input.runId,
      type: 'log',
      agent: input.agent,
      capability: 'ledger',
      summary: `${result.corrected} claim(s) had their verdict corrected to the canonical one.`,
      detail: 'A2.3: each criterion carries exactly one verdict, set by the criteria table.',
    });
  }

  for (const rejection of result.rejected) {
    await emitEvent({
      runId: input.runId,
      type: 'rejected',
      agent: input.agent,
      capability: 'ledger',
      summary: `Rejected a claim from ${input.agent}.`,
      detail: rejection.reason,
      data: {
        criterion: rejection.claim.criterion ?? null,
        pageUrl: rejection.claim.pageUrl ?? null,
      },
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Blocked criteria (A2.4)                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The two criteria no lane can reach are written into the ledger as BLOCKED
 * rows with their stated reason, once per run and phase.
 *
 * They go in deliberately. A2.4 forbids reporting them as passing, and the
 * only way a left join against the fixed list of 55 can distinguish "blocked"
 * from "clean" is if the block is a row.
 */
export async function recordBlockedCriteria(
  runId: string,
  phase: RunPhase,
  pageUrl: string,
): Promise<number> {
  const blocked = WCAG_CRITERIA.filter((criterion) => criterion.verdict === 'BLOCKED');

  const existing = await db
    .select({ criterion: findings.criterion })
    .from(findings)
    .where(
      and(
        eq(findings.runId, runId),
        eq(findings.phase, phase),
        inArray(
          findings.criterion,
          blocked.map((c) => c.id),
        ),
      ),
    );

  const already = new Set(existing.map((row) => row.criterion));
  const rows = blocked
    .filter((criterion) => !already.has(criterion.id))
    .map((criterion) => ({
      runId,
      phase,
      pageId: null,
      pageUrl,
      criterion: criterion.id,
      level: criterion.level,
      verdict: 'BLOCKED' as const,
      status: 'open' as const,
      severity: 'moderate' as const,
      // The ledger needs an agent; the dispatcher itself files these.
      agent: 'TREE' as const,
      summary: `${criterion.id} ${criterion.name} is out of reach for automated audit.`,
      detail: blockedReason(criterion.id) ?? 'No capability lane can observe this criterion.',
      sourcePath: null,
      sessionId: null,
    }));

  if (rows.length === 0) return 0;

  await db.insert(findings).values(rows);
  await emitEvent({
    runId,
    type: 'finding',
    capability: 'ledger',
    summary: `${rows.length} criterion(s) recorded as BLOCKED with a stated reason.`,
    detail: rows.map((row) => `${row.criterion}: ${row.detail}`).join('\n'),
    data: { phase, criteria: rows.map((row) => row.criterion) },
  });

  return rows.length;
}
