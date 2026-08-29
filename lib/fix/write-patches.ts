/**
 * `writePatches` — the FIX orchestrator.
 *
 * The pieces below this file already existed: `groupFindingsForFix` buckets
 * findings per source file, `buildFixPrompt` turns a bucket into a prompt, and
 * `parseFixResponse` validates what comes back and computes the diff on the
 * host. Nothing composed them. This does.
 *
 * Two properties are load-bearing and neither is obvious from the parts:
 *
 * 1. `FLAG` findings never reach the prompt. `groupFindingsForFix` excludes
 *    them first and unconditionally, so a finding the agent was only ever
 *    entitled to have an opinion about cannot end up rewritten as fact (A5.3,
 *    A5.4).
 *
 * 2. The diff is computed here, from the exact bytes we sent and the exact
 *    bytes we got back. A model-authored diff can describe a change it did not
 *    make; this one structurally cannot.
 */
import { runRosterAgent } from '@/lib/harness/run';

import { groupFindingsForFix, type FixableFinding } from './group';
import { buildFixPrompt, parseFixResponse } from './patch';
import { readRepoFile } from './source';

/** Shape the pipeline seam expects. Mirrors `WritePatches` in lanes.ts. */
export interface WritePatchesInput {
  runId: string;
  repoFullName: string;
  accessToken: string;
  /**
   * Ledger rows, not raw page content (A5.1). Typed as what grouping actually
   * consumes: a `Finding` row satisfies it, and stating the real type here is
   * what makes the verdict and severity unions reach `groupFindingsForFix`
   * intact — the FLAG exclusion below is only as good as the verdict it reads.
   */
  findings: readonly FixableFinding[];
  signal?: AbortSignal;
}

export interface WritePatchesResult {
  patches: readonly {
    sourcePath: string;
    diff: string;
    criteria: readonly string[];
    rationale: string;
    risk?: string | null;
    findingIds?: readonly string[];
  }[];
  skipped?: readonly { criterion: string; reason: string }[];
  sessionId?: string | null;
}

export async function writePatches(input: WritePatchesInput): Promise<WritePatchesResult> {
  const grouped = groupFindingsForFix(input.findings);
  const patches: WritePatchesResult['patches'][number][] = [];
  const skipped: { criterion: string; reason: string }[] = [];
  let sessionId: string | null = null;

  // `humanQueue` is everything grouping refused to touch: FLAG findings,
  // BLOCKED criteria, and DECIDE findings with no source path. Each carries a
  // reason so the run report can say why rather than silently dropping it.
  for (const item of grouped.humanQueue) {
    skipped.push({ criterion: item.finding.criterion, reason: item.explanation });
  }

  for (const group of grouped.groups) {
    if (input.signal?.aborted) break;

    const contents = await readRepoFile(
      input.repoFullName,
      input.accessToken,
      group.filePath,
      undefined,
      input.signal,
    );
    if (contents === null) {
      skipped.push({
        criterion: group.criteria[0] ?? 'unknown',
        reason: `could not read ${group.filePath} from ${input.repoFullName}`,
      });
      continue;
    }

    const prompt = buildFixPrompt(group, contents);

    let raw: unknown;
    try {
      const turn = await runRosterAgent('fix', prompt, { signal: input.signal });
      sessionId = turn.sessionId ?? sessionId;
      raw = turn.data ?? turn.text;
    } catch (error) {
      skipped.push({
        criterion: group.criteria[0] ?? 'unknown',
        reason: `FIX agent failed on ${group.filePath}: ${(error as Error).message}`,
      });
      continue;
    }

    // `parseFixResponse` is where a file that came back unchanged, empty,
    // truncated, or naming no finding becomes a skip with a reason rather
    // than a silent no-op patch.
    const parsed = parseFixResponse(group, raw, contents);
    for (const p of parsed.patches) {
      patches.push({
        sourcePath: p.filePath,
        diff: p.diff,
        criteria: p.criteria,
        rationale: p.rationale ?? '',
        risk: p.risk ?? null,
        findingIds: p.findingIds,
      });
    }
    for (const sk of parsed.skipped) {
      skipped.push({ criterion: sk.criterion ?? 'unknown', reason: sk.reason });
    }
  }

  return { patches, skipped, sessionId };
}
