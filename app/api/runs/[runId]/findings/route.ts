/**
 * `/api/runs/{runId}/findings` — the ledger, filtered.
 *
 * The ledger is the product, so this endpoint is the product's read surface.
 * Every view the interface offers is one of these queries: the criterion matrix
 * filters by `phase`, the finding detail by `criterion`, the human queue by
 * `verdict=FLAG`, the delta by `status`.
 *
 * Filters combine with AND; repeating a parameter is an OR within it, so
 * `?severity=critical&severity=serious` is "critical or serious".
 */
import { and, asc, desc, eq, inArray, type SQL } from 'drizzle-orm';
import { NextResponse } from 'next/server';

import { getCriterion } from '@/lib/db/criteria';
import { db } from '@/lib/db';
import {
  artifacts,
  findings,
  AGENT_NAMES,
  FINDING_STATUSES,
  RUN_PHASES,
  SEVERITIES,
  VERDICTS,
  type AgentName,
  type FindingStatus,
  type RunPhase,
  type Severity,
  type Verdict,
} from '@/lib/db/schema';
import { currentUser, NOT_FOUND, runForUser, UNAUTHORIZED } from '@/lib/pipeline/access';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Keep only the values that are in the enum. An unknown filter value is dropped. */
function pick<T extends string>(values: string[], allowed: readonly string[]): T[] {
  return values.filter((value) => allowed.includes(value)) as T[];
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
): Promise<NextResponse> {
  const user = await currentUser();
  if (!user) return NextResponse.json(UNAUTHORIZED, { status: 401 });

  const { runId } = await params;

  const owned = await runForUser(runId, user.id);
  if (!owned) return NextResponse.json(NOT_FOUND, { status: 404 });

  const query = new URL(request.url).searchParams;

  const clauses: SQL[] = [eq(findings.runId, runId)];

  const phase = pick<RunPhase>(query.getAll('phase'), RUN_PHASES);
  if (phase.length > 0) clauses.push(inArray(findings.phase, phase));

  const status = pick<FindingStatus>(query.getAll('status'), FINDING_STATUSES);
  if (status.length > 0) clauses.push(inArray(findings.status, status));

  const severity = pick<Severity>(query.getAll('severity'), SEVERITIES);
  if (severity.length > 0) clauses.push(inArray(findings.severity, severity));

  const verdict = pick<Verdict>(query.getAll('verdict'), VERDICTS);
  if (verdict.length > 0) clauses.push(inArray(findings.verdict, verdict));

  const agent = pick<AgentName>(query.getAll('agent'), AGENT_NAMES);
  if (agent.length > 0) clauses.push(inArray(findings.agent, agent));

  // A criterion filter is validated against the 55, so a typo returns an error
  // rather than an empty list the caller reads as "no findings".
  const criterion = query.getAll('criterion').map((value) => value.trim()).filter(Boolean);
  const unknown = criterion.filter((id) => !getCriterion(id));
  if (unknown.length > 0) {
    return NextResponse.json(
      {
        error: 'Unknown success criterion.',
        reason: `${unknown.join(', ')} is not one of the 55 WCAG 2.2 Level A/AA success criteria.`,
      },
      { status: 400 },
    );
  }
  if (criterion.length > 0) clauses.push(inArray(findings.criterion, criterion));

  const pageUrl = query.get('pageUrl');
  if (pageUrl) clauses.push(eq(findings.pageUrl, pageUrl));

  const pageId = query.get('pageId');
  if (pageId) clauses.push(eq(findings.pageId, pageId));

  const limit = Math.min(Math.max(Number(query.get('limit') ?? 200) || 200, 1), 1000);
  const offset = Math.max(Number(query.get('offset') ?? 0) || 0, 0);
  const order = query.get('order') === 'asc' ? asc(findings.createdAt) : desc(findings.createdAt);

  const rows = await db
    .select()
    .from(findings)
    .where(and(...clauses))
    .orderBy(order)
    .limit(limit)
    .offset(offset);

  /*
   * A9.1: every finding carries at least one artifact. The bytes stay out of
   * the response — a run can hold hundreds of screenshots — so this reports
   * what evidence exists and how to fetch it, which is what a list view needs.
   */
  const evidence = new Map<string, { id: string; kind: string; mimeType: string; hasBytes: boolean; storagePath: string | null }[]>();

  if (rows.length > 0) {
    const artifactRows = await db
      .select({
        id: artifacts.id,
        findingId: artifacts.findingId,
        kind: artifacts.kind,
        mimeType: artifacts.mimeType,
        storagePath: artifacts.storagePath,
      })
      .from(artifacts)
      .where(
        inArray(
          artifacts.findingId,
          rows.map((row) => row.id),
        ),
      );

    for (const artifact of artifactRows) {
      if (!artifact.findingId) continue;
      const list = evidence.get(artifact.findingId) ?? [];
      list.push({
        id: artifact.id,
        kind: artifact.kind,
        mimeType: artifact.mimeType,
        hasBytes: artifact.storagePath === null,
        storagePath: artifact.storagePath,
      });
      evidence.set(artifact.findingId, list);
    }
  }

  return NextResponse.json({
    findings: rows.map((row) => {
      const criterionMeta = getCriterion(row.criterion);
      return {
        ...row,
        criterionName: criterionMeta?.name ?? null,
        plainEnglish: criterionMeta?.plainEnglish ?? null,
        stateDependent: criterionMeta?.stateDependent ?? false,
        evidence: evidence.get(row.id) ?? [],
      };
    }),
    count: rows.length,
    limit,
    offset,
  });
}
