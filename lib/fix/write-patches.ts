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
 *
 *    What "the exact bytes we got back" means depends on the file's size, and
 *    `chooseFixContract` decides it once for the prompt, the response format and
 *    the parser. A small file comes back whole. A large one comes back as a
 *    short list of exact string replacements, because a model asked for two
 *    thousand lines regenerates them rather than copying them - one real run
 *    returned a paraphrase of the file with live code replaced by a placeholder,
 *    and it was accepted because it was neither empty nor short. `parseFixResponse`
 *    now also refuses a file that gained a summary marker and a diff out of all
 *    proportion to the findings it claims, each as a skip with a stated reason.
 *
 * 3. Every path out of this function that does not produce a patch produces a
 *    reason. A FIX turn that failed, a response that could not be read, a file
 *    that came back unchanged — each becomes an entry in `skipped`, and the
 *    run report says which finding it belonged to and why. "FIX produced no
 *    patches" with nothing after it is the one outcome this function will not
 *    return.
 */
import { AGENT_ROSTER, buildAgentSpec, buildFixEditsSpec } from '@/lib/harness/agents';
import { getTrueForgeClient, type AgentSpec } from '@/lib/harness/client';
import { runAgentWithFallback, runRosterAgent, type AgentRunResult } from '@/lib/harness/run';

import { groupFindingsForFix, type FixableFinding } from './group';
import {
  FixResponseError,
  buildFixPrompt,
  chooseFixContract,
  parseFixResponse,
  type ParsedFixResponse,
} from './patch';
import { readRepoFile } from './source';

/**
 * One FIX turn held to the targeted-edit contract.
 *
 * The saved `fix` agent is registered with the whole-file response format, and
 * that is the right default: most files are small enough for it and it has the
 * simplest failure mode there is. A file too large to be returned whole needs
 * the other contract, and the cheapest honest way to get it is to dispatch the
 * saved agent's own manifest with one field swapped — same model, same skills,
 * same sandbox — rather than registering an eighth agent that would then have
 * to be kept in step with the roster forever.
 *
 * The manifest is read back from the control plane for the same reason
 * `resolveFallbackSpec` does it: a manifest rebuilt locally silently drops the
 * skills and sandbox settings the server actually configured, which would make
 * this a different agent rather than the same one asked a different question.
 * The roster's own manifest is the last resort, not the first choice.
 */
async function runFixEditsTurn(
  prompt: string,
  signal?: AbortSignal,
): Promise<AgentRunResult<unknown>> {
  const definition = AGENT_ROSTER.fix;

  let saved: AgentSpec | null = null;
  try {
    const agent = (await getTrueForgeClient().listAgents(signal)).find((a) => a.name === 'fix');
    if (agent) saved = agent.manifest;
  } catch {
    // The control plane could not tell us; use what the roster knows.
  }
  const base = saved ?? buildAgentSpec(definition);
  const primary = buildFixEditsSpec(base);

  const fallback = (): AgentSpec | null => {
    const second = definition.fallbackModel;
    if (!second || base.model.name === second) return null;
    return buildFixEditsSpec({ ...base, model: { ...base.model, name: second } });
  };

  return runAgentWithFallback(primary, fallback, prompt, { signal });
}

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
  /**
   * Repairs and contract drift the parser had to work around. Not failures —
   * the run still wants them in the timeline, because a warning here is how a
   * stale agent manifest announces itself before it costs a whole run.
   */
  warnings?: readonly string[];
  sessionId?: string | null;
}

export async function writePatches(input: WritePatchesInput): Promise<WritePatchesResult> {
  const grouped = groupFindingsForFix(input.findings);
  const patches: WritePatchesResult['patches'][number][] = [];
  const skipped: { criterion: string; reason: string }[] = [];
  const warnings: string[] = [];
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
    // One decision, taken from the file's size, about the shape of the answer.
    // `buildFixPrompt` writes the matching OUTPUT section from the same call and
    // `parseFixResponse` reads it back the same way, so the prompt, the schema
    // the provider enforces and the parser cannot describe three different
    // things - which is precisely the drift that cost this project a whole run.
    const contract = chooseFixContract(contents);

    let raw: unknown;
    try {
      const turn =
        contract === 'targeted-edits'
          ? await runFixEditsTurn(prompt, input.signal)
          : await runRosterAgent('fix', prompt, { signal: input.signal });
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
    // than a silent no-op patch. A response it cannot read at all throws, and
    // that is a reason too — it must reach the run as one rather than as an
    // unhandled error that takes the remaining files down with it.
    let parsed: ParsedFixResponse;
    try {
      parsed = parseFixResponse(group, raw, contents);
    } catch (error) {
      const detail =
        error instanceof FixResponseError
          ? error.message
          : `FIX response for ${group.filePath} could not be read: ${(error as Error).message}`;
      for (const criterion of group.criteria) {
        skipped.push({ criterion, reason: detail });
      }
      if (group.criteria.length === 0) {
        skipped.push({ criterion: 'unknown', reason: detail });
      }
      continue;
    }

    warnings.push(...parsed.warnings);
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

  return { patches, skipped, warnings, sessionId };
}
