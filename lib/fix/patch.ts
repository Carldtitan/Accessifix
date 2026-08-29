/**
 * The FIX prompt and the patch it produces (A5.2, A5.5).
 *
 * Two jobs, deliberately in one module because they are two halves of one
 * contract: `buildFixPrompt` states what the agent must return, and
 * `parseFixResponse` refuses anything that is not that.
 *
 * The agent returns the **whole new file**, not a diff. That is not a
 * stylistic choice. A model-authored unified diff has to be right about line
 * numbers and surrounding context before it can be right about accessibility,
 * and when it is wrong the failure is a patch that will not apply — which the
 * run discovers only in the sandbox. Full contents always apply. The diff shown
 * to the reviewer and stored in the ledger is computed here, from the file we
 * gave the agent and the file it gave back, so it is a true description of the
 * change by construction.
 *
 * The provider-side half of that contract lives in `lib/harness/schemas.ts`
 * as `FILE_PATCH_RESPONSE_FORMAT`, because that is what the saved FIX
 * manifest is built from, and it is re-exported here as
 * `FIX_PATCH_RESPONSE_FORMAT` so there is exactly one description of a FIX
 * response in the codebase. There used to be two — the manifest asked for a
 * unified diff while this module asked for file contents — and the result was
 * a run that produced nothing and could not say why. The parser below still
 * accepts the old shape, but it says out loud that it did.
 */

import { z } from 'zod';

import { FILE_PATCH_RESPONSE_FORMAT } from '@/lib/harness/schemas';

import type { FixGroup, GroupedFinding } from './group';

/**
 * The `response_format` shape TrueForge accepts, declared structurally so the
 * parser's own types do not depend on the client's zod unions.
 */
export interface JsonSchemaResponseFormat {
  readonly type: 'json_schema';
  readonly json_schema: {
    readonly name: string;
    readonly description?: string;
    readonly schema: Record<string, unknown>;
    readonly strict?: boolean;
  };
}

/* -------------------------------------------------------------------------- */
/* The patch                                                                  */
/* -------------------------------------------------------------------------- */

export interface FilePatch {
  /** Repository-relative path. One patch per file (A5.2). */
  readonly filePath: string;
  /** The complete file after the fix. What gets written into the sandbox. */
  readonly newContents: string;
  /** The file as it was handed to the agent. Kept for the before/after evidence. */
  readonly originalContents: string;
  /** Unified diff, computed here rather than trusted from the model. */
  readonly diff: string;
  /** A5.5: exactly which findings this patch addresses. */
  readonly findingIds: readonly string[];
  /** The criterion numbers those findings cite, ascending. */
  readonly criteria: readonly string[];
  /** Why the change is correct, in prose a reviewer can check. */
  readonly rationale: string;
  /** What it might plausibly break. Null when the agent claimed none. */
  readonly risk: string | null;
  readonly stats: PatchStats;
}

export interface PatchStats {
  readonly linesAdded: number;
  readonly linesRemoved: number;
  readonly hunks: number;
}

/** A finding FIX declined to touch, with the reason it gave. */
export interface SkippedFix {
  readonly findingIds: readonly string[];
  readonly criterion: string | null;
  readonly reason: string;
}

export interface ParsedFixResponse {
  readonly patches: readonly FilePatch[];
  readonly skipped: readonly SkippedFix[];
  /** Repairs and rejections applied while parsing. Surface these in the timeline. */
  readonly warnings: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* Response contract                                                          */
/* -------------------------------------------------------------------------- */

const CRITERION_PATTERN = /^[1-4]\.\d{1,2}\.\d{1,2}$/;

const RawFileSchema = z.object({
  filePath: z.string().min(1),
  /**
   * Optional at the schema level so that a response in the wrong shape becomes
   * a skip carrying a reason rather than a `FixResponseError` that says only
   * "does not match the schema". `parseFixResponse` requires one of
   * `newContents` or `diff` and names which was missing.
   */
  newContents: z.string().optional(),
  /**
   * Never asked for, sometimes given: a manifest still pinned to the old
   * `accessifix_patch_set` shape constrains the model to answer with a diff.
   * Accepted here only so the host can apply it against the exact bytes it
   * sent and then compute its own diff from the result.
   */
  diff: z.string().optional(),
  criteria: z.array(z.string()).default([]),
  findingIds: z.array(z.string()).default([]),
  rationale: z.string().min(1),
  risk: z.string().nullish(),
});

const RawSkippedSchema = z.object({
  criterion: z.string().nullish(),
  findingIds: z.array(z.string()).default([]),
  reason: z.string().min(1),
});

/**
 * Accepts the shape the prompt asks for, and quietly accepts the near-misses a
 * model reaches for: `patches` instead of `files`, `sourcePath` instead of
 * `filePath`, `contents` instead of `newContents`. Rewriting a key is a repair;
 * inventing a value is not, and nothing below invents one.
 *
 * The top-level alias is not a nicety. `files` carries a `[]` default, so a
 * response that used `patches` at the top level parsed cleanly into a response
 * with no files and no skips — a silent no-op, which is the one failure mode
 * this product exists to eliminate. `normalizeResponse` collapses the aliases
 * before validation, and `parseFixResponse` refuses to return empty-handed.
 */
export const FixResponseSchema = z.preprocess(
  normalizeResponse,
  z.object({
    files: z.array(z.preprocess(normalizeFileEntry, RawFileSchema)).default([]),
    skipped: z.array(z.preprocess(normalizeSkippedEntry, RawSkippedSchema)).default([]),
  }),
);

export type FixResponse = z.infer<typeof FixResponseSchema>;

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function firstString(source: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

function firstArray(source: Record<string, unknown>, keys: readonly string[]): unknown[] {
  for (const key of keys) {
    const value = source[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

/** The names a FIX response has actually arrived under, at the top level. */
const FILES_KEYS = ['files', 'patches', 'filePatches', 'changes'] as const;

function normalizeResponse(value: unknown): unknown {
  const raw = asRecord(value);
  return {
    ...raw,
    files: firstArray(raw, FILES_KEYS),
    skipped: firstArray(raw, ['skipped', 'skips', 'declined']),
  };
}

/** Which of `FILES_KEYS` a payload actually used. For the skip reason. */
export function fileKeysUsed(payload: unknown): string[] {
  const raw = asRecord(payload);
  return FILES_KEYS.filter((key) => Array.isArray(raw[key]));
}

function normalizeFileEntry(value: unknown): unknown {
  const raw = asRecord(value);
  return {
    ...raw,
    filePath: firstString(raw, ['filePath', 'sourcePath', 'path', 'file']),
    newContents: firstString(raw, ['newContents', 'newContent', 'contents', 'content', 'source']),
    diff: firstString(raw, ['diff', 'patch', 'unifiedDiff', 'unified_diff']),
    rationale: firstString(raw, ['rationale', 'reason', 'explanation', 'why']),
  };
}

function normalizeSkippedEntry(value: unknown): unknown {
  const raw = asRecord(value);
  return {
    ...raw,
    criterion: firstString(raw, ['criterion', 'criteria', 'sc']) ?? null,
    reason: firstString(raw, ['reason', 'explanation', 'why', 'note']),
  };
}

/**
 * `response_format` for a FIX turn dispatched with `buildFixPrompt`.
 *
 * The same object the saved FIX manifest is built from, so the constraint the
 * provider applies and the shape this module parses cannot drift apart again.
 * A saved manifest whose `json_schema.name` is not `FIX_RESPONSE_FORMAT_NAME`
 * is stale; `npm run agents:init -- --update` replaces it.
 */
export const FIX_PATCH_RESPONSE_FORMAT =
  FILE_PATCH_RESPONSE_FORMAT as JsonSchemaResponseFormat;

/** The `json_schema.name` a correctly-registered FIX manifest carries. */
export const FIX_RESPONSE_FORMAT_NAME = FIX_PATCH_RESPONSE_FORMAT.json_schema.name;

/* -------------------------------------------------------------------------- */
/* The prompt                                                                 */
/* -------------------------------------------------------------------------- */

export interface FixPromptOptions {
  /** `owner/repo`, for the header line. */
  readonly repoFullName?: string;
  /** The commit or branch the file contents were read at. */
  readonly ref?: string;
  /** Anything the caller knows about the project: framework, conventions. */
  readonly projectNotes?: string;
  /** Hard cap on file characters included. Default 120_000. */
  readonly maxFileChars?: number;
}

/**
 * The four rules that separate an accessibility fix from an accessibility
 * gesture. Each one names a failure this product finds in real code, and each
 * one is the thing a model gets wrong when it is trying to be helpful.
 */
const REMEDIATION_RULES = `NON-NEGOTIABLE REMEDIATION RULES

1. Never use a div or a span for anything clickable. If it takes a click, it is a <button type="button">; if it navigates, it is an <a href>. A div with an onClick is invisible to assistive technology and unreachable from a keyboard, and wrapping it in role="button" plus tabIndex is a worse fix than using the element that already does all of it. Change the element.

2. Never add ARIA where a native element already carries the semantics. aria-label on a <button> that already has a visible text label, role="button" on a <button>, role="navigation" on a <nav>, aria-required on an input that already has required — all of these are noise, and some of them silently override the accessible name a screen reader would otherwise have read. The first rule of ARIA is not to use ARIA. Reach for it only when there is no native element that does the job, and say in your rationale which native element you ruled out and why.

3. Every interactive component handles Tab, Enter, Space and Escape. Tab must reach it and Tab must leave it. Enter and Space must activate it — both, because a button responds to both and users expect that of anything that looks like one. Escape must dismiss anything that opened over the page, and focus must return to the control that opened it. If you cannot make all four work in this file, say so in \`skipped\` rather than shipping a control that traps a keyboard user.

4. ARIA state attributes must be wired to component state, never written as static text. aria-expanded={isOpen}, not aria-expanded="false". aria-checked={checked}, aria-selected={index === activeIndex}, aria-pressed={isPressed}. A hardcoded state attribute is the exact failure this product exists to catch: the tree changes when the user acts, the attribute does not, and a screen reader announces the opposite of what is on screen. Bind the attribute to the same variable that drives the visual state so the two cannot diverge again.`;

const OUTPUT_RULES = `OUTPUT

- Return the COMPLETE new contents of the file in \`newContents\`. Every line from the first to the last, including the parts you did not touch. Not a diff, not an excerpt, not a fragment with "... rest unchanged ...". The application computes the diff itself by comparing what you return against what it gave you, so an abbreviated file is read as a deletion of everything you left out.
- Preserve the file's existing indentation, quote style, import order and trailing newline. Change only what the findings require. Every unrelated line you touch is a reason for a reviewer to reject the whole patch.
- Do not reformat, rename, restructure, upgrade a dependency, or improve adjacent code, however tempting.
- Do not change the visual design. Adding an accessible name, a label association, a state binding, a keyboard handler or a focus style is in scope. Redesigning a component is not.
- Keep the framework's idioms. If the file uses a design-system Button, keep using it. If it is a server component, it stays one. If the project has design tokens, change the token, not the component.
- List in \`findingIds\` the ids of exactly the findings your change addresses, and in \`criteria\` their criterion numbers.
- If you cannot fix a finding safely, put it in \`skipped\` with a real reason. An honest skip is worth more than a patch that breaks the build: VERIFY runs the repository's own test suite against your work, and a failing suite stops the pull request entirely.
- No prose outside the JSON object.`;

/**
 * Build the FIX turn for one file.
 *
 * A5.1: the findings come from the ledger. The page content the finding was
 * observed on is not included and must not be — the agent's job is to read the
 * source and the claim, not to re-audit the page.
 */
export function buildFixPrompt(
  group: FixGroup,
  fileContents: string,
  options: FixPromptOptions = {},
): string {
  const maxChars = options.maxFileChars ?? 120_000;
  const truncated = fileContents.length > maxChars;
  const body = truncated ? fileContents.slice(0, maxChars) : fileContents;

  const header = [
    `FILE: ${group.filePath}`,
    options.repoFullName ? `REPOSITORY: ${options.repoFullName}` : null,
    options.ref ? `REF: ${options.ref}` : null,
    `FINDINGS: ${group.findings.length} (${group.criteria.join(', ')})`,
    group.pageUrls.length > 0 ? `OBSERVED ON: ${group.pageUrls.join(', ')}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');

  const sections = [
    'You are fixing accessibility defects in one source file.',
    '',
    header,
    '',
    'FINDINGS FROM THE LEDGER',
    '',
    'Every finding below was decided by an audit agent against the deployed site. Each one',
    'names a WCAG 2.2 success criterion and points at this file. Fix all of them in a single',
    'change to this one file.',
    '',
    renderFindings(group.findings),
    '',
    REMEDIATION_RULES,
    '',
    OUTPUT_RULES,
    '',
    options.projectNotes ? `PROJECT NOTES\n\n${options.projectNotes}\n` : '',
    `CURRENT CONTENTS OF ${group.filePath}`,
    '',
    truncated
      ? `(TRUNCATED at ${maxChars} characters. Do not return a truncated file — if you cannot ` +
        'see the whole file, skip the findings you cannot safely fix.)'
      : '',
    '',
    '```',
    body,
    '```',
  ];

  return sections.filter((line) => line !== '').join('\n').concat('\n');
}

function renderFindings(findings: readonly GroupedFinding[]): string {
  return findings
    .map((finding, index) => {
      const record = finding.criterionRecord;
      const lines = finding.lines.length > 0 ? ` (line ${finding.lines.join(', ')})` : '';
      const parts = [
        `${index + 1}. [${finding.id}] SC ${record.id} ${record.name} (Level ${record.level}) — ${finding.severity}${lines}`,
        `   Requirement: ${record.plainEnglish}.`,
        `   Observed: ${finding.summary}`,
      ];
      if (finding.detail) parts.push(`   Evidence: ${collapse(finding.detail, 1200)}`);
      if (finding.selector) parts.push(`   Element: ${finding.selector}`);
      return parts.join('\n');
    })
    .join('\n\n');
}

function collapse(text: string, max: number): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length <= max ? single : `${single.slice(0, max)}…`;
}

/* -------------------------------------------------------------------------- */
/* Parsing                                                                    */
/* -------------------------------------------------------------------------- */

export interface ParseFixOptions {
  /**
   * Reject a file that came back dramatically shorter than it went in, as a
   * fraction of the original length. Default 0.4 — below that it is almost
   * always an abbreviated file rather than a deletion the findings asked for.
   */
  readonly minLengthRatio?: number;
  /** Lines of context in the generated diff. Default 3. */
  readonly diffContext?: number;
}

/**
 * Validate a FIX response against the file it was asked to change.
 *
 * Everything that could let a bad patch through is checked here rather than in
 * the sandbox: a path the agent invented, a criterion it was not given, a
 * finding id that belongs to another file, a file returned unchanged, a file
 * returned truncated. Each of those becomes a skip with a reason, never a patch.
 */
export function parseFixResponse(
  group: FixGroup,
  raw: unknown,
  originalContents: string,
  options: ParseFixOptions = {},
): ParsedFixResponse {
  const warnings: string[] = [];
  const skipped: SkippedFix[] = [];
  const patches: FilePatch[] = [];

  const payload = typeof raw === 'string' ? extractJson(raw) : raw;
  if (payload === undefined) {
    throw new FixResponseError(
      `FIX returned no JSON for ${group.filePath}.`,
      typeof raw === 'string' ? raw : undefined,
    );
  }

  const keysUsed = fileKeysUsed(payload);
  const parsed = FixResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new FixResponseError(
      `FIX response for ${group.filePath} does not match the schema: ${formatIssues(parsed.error)}` +
        (keysUsed.length > 0 && !keysUsed.includes('files')
          ? ` The response used \`${keysUsed.join('`, `')}\` where \`files\` was expected, which is the ` +
            `${FIX_RESPONSE_FORMAT_NAME} contract drifting from the saved FIX manifest. ` +
            'Re-register it with `npm run agents:init -- --update`.'
          : ''),
      typeof raw === 'string' ? raw : undefined,
      parsed.error,
    );
  }

  if (keysUsed.length > 0 && !keysUsed.includes('files')) {
    warnings.push(
      `FIX answered under \`${keysUsed.join('`, `')}\` rather than \`files\`. The saved FIX ` +
        'manifest is out of date; re-register it with `npm run agents:init -- --update`.',
    );
  }

  const validIds = new Set(group.findingIds);
  const validCriteria = new Set(group.criteria);
  const minRatio = options.minLengthRatio ?? 0.4;

  for (const skip of parsed.data.skipped) {
    skipped.push({
      findingIds: skip.findingIds.filter((id) => validIds.has(id)),
      criterion: skip.criterion && CRITERION_PATTERN.test(skip.criterion) ? skip.criterion : null,
      reason: skip.reason,
    });
  }

  // A5.2: a FIX turn owns exactly one file and emits at most one patch for it.
  // Two accepted entries for the same path would leave the sandbox write and the
  // Git tree disagreeing about which one is authoritative — and `createTree`
  // refuses duplicate paths outright.
  let emitted = false;

  for (const file of parsed.data.files) {
    if (emitted) {
      warnings.push(
        `Discarded a further entry for "${file.filePath}": a patch for ` +
          `"${group.filePath}" was already accepted, and one FIX turn writes one file.`,
      );
      continue;
    }

    const returnedPath = normalizeReturnedPath(file.filePath);
    if (returnedPath !== group.filePath) {
      if (parsed.data.files.length === 1) {
        warnings.push(
          `FIX returned the path "${file.filePath}" but was given "${group.filePath}". ` +
            'Treating it as the file it was asked to change.',
        );
      } else {
        warnings.push(
          `Discarded a patch for "${file.filePath}": this FIX turn only owns ` +
            `"${group.filePath}", and one turn writes one file.`,
        );
        continue;
      }
    }

    /*
     * The prompt asks for whole contents. A model held to a stale manifest
     * answers with a diff instead, and throwing that away is how a run ends up
     * with nothing to show and nothing to say. Applying it here does not weaken
     * the rule that the host owns the diff: `applyUnifiedDiff` checks every
     * context and every removed line against the exact bytes we sent, so a diff
     * that describes some other file cannot apply at all, and the diff we store
     * is still recomputed below from the bytes on both ends.
     */
    let newContents = file.newContents;
    if (typeof newContents !== 'string') {
      if (typeof file.diff === 'string' && file.diff.trim().length > 0) {
        const applied = applyUnifiedDiff(originalContents, file.diff);
        if (applied === null) {
          skipped.push({
            findingIds: group.findingIds,
            criterion: null,
            reason:
              `FIX answered with a unified diff for ${group.filePath} rather than the file ` +
              'contents the prompt asked for, and the diff does not apply to the bytes that ' +
              'were sent. It was rejected rather than guessed at. The saved FIX manifest is ' +
              'out of date; re-register it with `npm run agents:init -- --update`.',
          });
          continue;
        }
        warnings.push(
          `FIX returned a diff for ${group.filePath} instead of the file contents. It applied ` +
            'cleanly to the bytes we sent, so the patch was rebuilt from the result.',
        );
        newContents = applied;
      } else {
        skipped.push({
          findingIds: group.findingIds,
          criterion: null,
          reason:
            `FIX returned an entry for ${group.filePath} carrying neither \`newContents\` nor a ` +
            'diff, so there is nothing to apply. The findings stay open.',
        });
        continue;
      }
    }

    if (newContents.trim().length === 0) {
      skipped.push({
        findingIds: group.findingIds,
        criterion: null,
        reason: `FIX returned an empty file for ${group.filePath}. Rejected — an accessibility fix never deletes a file.`,
      });
      continue;
    }

    if (newContents === originalContents) {
      skipped.push({
        findingIds: group.findingIds,
        criterion: null,
        reason: `FIX returned ${group.filePath} unchanged, so there is nothing to review. The findings stay open.`,
      });
      continue;
    }

    if (isNormalizationOnly(originalContents, newContents)) {
      skipped.push({
        findingIds: group.findingIds,
        criterion: null,
        reason:
          `FIX returned ${group.filePath} with only its line endings or its final newline ` +
          'changed. That fixes no finding, and rewriting every line of a file to reach it is ' +
          'churn a reviewer would have to read, so it was rejected.',
      });
      continue;
    }

    if (looksTruncated(originalContents, newContents, minRatio)) {
      skipped.push({
        findingIds: group.findingIds,
        criterion: null,
        reason:
          `FIX returned ${group.filePath} at ${newContents.length} characters against an ` +
          `original of ${originalContents.length}. That is an abbreviated file, not a patch, ` +
          'so it was rejected rather than applied.',
      });
      continue;
    }

    const criteria = [...new Set(file.criteria.filter((c) => validCriteria.has(c)))].sort((a, b) =>
      a.localeCompare(b, 'en', { numeric: true }),
    );
    const invented = file.criteria.filter((c) => !validCriteria.has(c));
    if (invented.length > 0) {
      warnings.push(
        `FIX claimed criteria not in this group and they were dropped: ${invented.join(', ')}.`,
      );
    }

    const findingIds = resolveFindingIds(group, file.findingIds, criteria, warnings);
    if (findingIds.length === 0) {
      skipped.push({
        findingIds: group.findingIds,
        criterion: null,
        reason:
          `FIX changed ${group.filePath} but named no finding it addresses. A patch that ` +
          'cannot say what it fixes is not recorded (A5.5).',
      });
      continue;
    }

    const diff = unifiedDiff(
      group.filePath,
      originalContents,
      newContents,
      options.diffContext ?? 3,
    );

    patches.push({
      filePath: group.filePath,
      newContents,
      originalContents,
      diff,
      findingIds,
      criteria: criteria.length > 0 ? criteria : criteriaOf(group, findingIds),
      rationale: file.rationale,
      risk: file.risk ?? null,
      stats: diffStats(diff),
    });
    emitted = true;
  }

  /*
   * The rule this whole module exists to enforce, stated once at the end: a FIX
   * turn that produced no patch has to say why. A response that named no file
   * and skipped nothing used to leave both lists empty, the run reported "FIX
   * produced no patches" with no explanation, and the findings were closed out
   * of the pass without anybody being told. That is the failure mode this
   * product exists to eliminate, so it must not be ours.
   */
  if (patches.length === 0 && skipped.length === 0) {
    const shape =
      keysUsed.length > 0
        ? `It answered under \`${keysUsed.join('`, `')}\` with no entries.`
        : 'It named no `files` array at all.';
    skipped.push({
      findingIds: group.findingIds,
      criterion: null,
      reason:
        `FIX returned a response for ${group.filePath} that proposed no change and skipped ` +
        `nothing. ${shape} Nothing was applied and the findings stay open for a human.`,
    });
  }

  return { patches, skipped, warnings };
}

/** Thrown when a FIX response cannot be read at all. Retryable at the call site. */
export class FixResponseError extends Error {
  readonly raw?: string;

  constructor(message: string, raw?: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'FixResponseError';
    this.raw = raw;
  }
}

function normalizeReturnedPath(value: string): string {
  return value
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '');
}

/**
 * True when the two versions differ only in line endings or the final newline.
 *
 * A model asked to fix an accessibility defect sometimes returns the file with
 * its terminators rewritten and nothing else. The diff for that is honest — every
 * line changed — but it is also a whole-file rewrite that fixes nothing, so it is
 * refused here rather than put in front of a reviewer.
 */
function isNormalizationOnly(before: string, after: string): boolean {
  if (before === after) return false;
  const canonical = (text: string): string => text.replace(/\r\n/g, '\n').replace(/\n$/, '');
  return canonical(before) === canonical(after);
}

function looksTruncated(before: string, after: string, minRatio: number): boolean {
  if (before.length < 200) return false;
  if (after.length >= before.length * minRatio) return false;
  return true;
}

/**
 * Which findings a patch addresses. The agent's own list is preferred; when it
 * gave none, the criteria it named are mapped back onto the group's findings.
 *
 * When it named neither, this returns nothing, and the caller turns the response
 * into a skip. Assigning every finding in the file to a patch that could not say
 * what it fixes would record attribution nobody claimed — A5.5 asks for *exactly*
 * the findings a patch addresses, the pull-request body cites them one by one,
 * and the re-check then reports them resolved. A guess at that is worse than an
 * honest refusal, and it is what makes the caller's "named no finding" rejection
 * reachable at all.
 */
function resolveFindingIds(
  group: FixGroup,
  claimed: readonly string[],
  criteria: readonly string[],
  warnings: string[],
): string[] {
  const valid = new Set(group.findingIds);
  const fromClaim = claimed.filter((id) => valid.has(id));
  const rejected = claimed.filter((id) => !valid.has(id));
  if (rejected.length > 0) {
    warnings.push(
      `FIX referenced finding ids that are not in this group and they were dropped: ${rejected.join(', ')}.`,
    );
  }
  if (fromClaim.length > 0) return [...new Set(fromClaim)];

  if (criteria.length > 0) {
    const set = new Set(criteria);
    const matched = group.findings.filter((f) => set.has(f.criterion)).map((f) => f.id);
    if (matched.length > 0) return matched;
  }

  return [];
}

function criteriaOf(group: FixGroup, findingIds: readonly string[]): string[] {
  const ids = new Set(findingIds);
  const criteria = new Set(
    group.findings.filter((f) => ids.has(f.id)).map((f) => f.criterion),
  );
  return [...criteria].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

/**
 * `response_format` should hand back a bare object, but a model that wrapped it
 * in a fence or a sentence has still done the work. Recover it.
 */
function extractJson(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;

  const candidates = [trimmed];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(trimmed.slice(first, last + 1));

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // next shape
    }
  }
  return undefined;
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ');
}

/* -------------------------------------------------------------------------- */
/* Diff                                                                       */
/* -------------------------------------------------------------------------- */

type DiffOp = { readonly kind: ' ' | '-' | '+'; readonly line: string };

/** Cells in the LCS table before the diff degrades to a whole-file replacement. */
const LCS_CELL_CAP = 4_000_000;

/**
 * A unified diff of two versions of one file.
 *
 * Computed on the host from the exact bytes we sent and the exact bytes we got
 * back, so what a reviewer sees on the approval card and what lands in the
 * commit are the same thing. Nothing here trusts the model's arithmetic.
 */
export function unifiedDiff(
  filePath: string,
  before: string,
  after: string,
  context = 3,
): string {
  if (before === after) return '';

  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);

  // The one change a line diff cannot see: identical lines, different final
  // newline. Handled explicitly so `before !== after` can never produce an empty
  // diff — that equivalence is the whole guarantee this function exists for.
  const terminatorOnly =
    beforeLines.trailingNewline !== afterLines.trailingNewline &&
    beforeLines.lines.length === afterLines.lines.length &&
    beforeLines.lines.every((line, index) => line === afterLines.lines[index]);

  const ops = terminatorOnly
    ? lastLineReplacement(beforeLines.lines, afterLines.lines)
    : diffLines(beforeLines.lines, afterLines.lines);

  // The same blind spot as `terminatorOnly`, in the case where the rest of the
  // file did change: the final line is identical on both sides, so it comes out
  // as context, and a context line carries no `\ No newline at end of file`
  // marker. The terminator change would then vanish from the diff entirely —
  // and a diff that omits a real byte difference breaks the guarantee this
  // function exists for, that what a reviewer reads is what lands in the commit.
  // Forcing that last line through as a replacement puts the marker back on
  // whichever side actually lost its newline.
  if (!terminatorOnly && beforeLines.trailingNewline !== afterLines.trailingNewline) {
    // Whichever ops produce the two files' final lines: the last op that is not
    // a deletion ends the new file, the last that is not an addition ends the
    // old one. They are often the same op and occasionally neither is last
    // overall — lines deleted off the end leave the new file's final line as a
    // context op several places back.
    const splitContextAt = (index: number): void => {
      const op = index >= 0 ? ops[index] : undefined;
      if (!op || op.kind !== ' ') return;
      ops.splice(index, 1, { kind: '-', line: op.line }, { kind: '+', line: op.line });
    };
    const lastIndexWhere = (exclude: DiffOp['kind']): number => {
      for (let i = ops.length - 1; i >= 0; i -= 1) if (ops[i]!.kind !== exclude) return i;
      return -1;
    };

    splitContextAt(lastIndexWhere('-'));
    splitContextAt(lastIndexWhere('+'));
  }

  const oldAt: number[] = new Array(ops.length);
  const newAt: number[] = new Array(ops.length);
  let oldLine = 1;
  let newLine = 1;
  for (let i = 0; i < ops.length; i += 1) {
    oldAt[i] = oldLine;
    newAt[i] = newLine;
    const kind = ops[i]!.kind;
    if (kind === ' ') {
      oldLine += 1;
      newLine += 1;
    } else if (kind === '-') {
      oldLine += 1;
    } else {
      newLine += 1;
    }
  }

  const ranges = changeRanges(ops, context);
  if (ranges.length === 0) return '';

  const out: string[] = [`--- a/${filePath}`, `+++ b/${filePath}`];

  for (const [start, end] of ranges) {
    let oldCount = 0;
    let newCount = 0;
    const body: string[] = [];

    for (let i = start; i <= end; i += 1) {
      const op = ops[i]!;
      if (op.kind !== '+') oldCount += 1;
      if (op.kind !== '-') newCount += 1;
      body.push(`${op.kind}${op.line}`);

      // `\ No newline at end of file` goes immediately after the line it
      // describes, on whichever side is missing the terminator. Only emitted
      // for changed lines: a context line belongs to both sides, and marking
      // one of them there would describe the wrong file.
      const lastRemoved =
        op.kind === '-' &&
        !beforeLines.trailingNewline &&
        oldAt[i] === beforeLines.lines.length;
      const lastAdded =
        op.kind === '+' && !afterLines.trailingNewline && newAt[i] === afterLines.lines.length;
      if (lastRemoved || lastAdded) body.push('\\ No newline at end of file');
    }

    const oldStart = oldCount === 0 ? Math.max(0, oldAt[start]! - 1) : oldAt[start]!;
    const newStart = newCount === 0 ? Math.max(0, newAt[start]! - 1) : newAt[start]!;
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    out.push(...body);
  }

  return `${out.join('\n')}\n`;
}

export function diffStats(diff: string): PatchStats {
  let added = 0;
  let removed = 0;
  let hunks = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@')) hunks += 1;
    else if (line.startsWith('+') && !line.startsWith('+++')) added += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) removed += 1;
  }
  return { linesAdded: added, linesRemoved: removed, hunks };
}

/* -------------------------------------------------------------------------- */
/* Reversing the diff                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The bytes a diff produces, applied to the exact bytes it was computed from.
 *
 * VERIFY and the pull request both need the *whole* patched file — one to write
 * it into the build sandbox, the other to commit it and to digest it for the
 * approval — but the only thing that survives from FIX to those phases is the
 * unified diff, because the `patches` row stores the diff and nothing else.
 * So the contents have to be reconstructed, and reconstructing them by guessing
 * would put unreviewed bytes into somebody's repository.
 *
 * This does not guess. Every context and removed line is checked against the
 * original before it is consumed, so a file that has drifted since FIX read it
 * fails here rather than being force-applied, and `rebuildFilePatch` below then
 * re-derives the diff from the result and requires it to equal the diff it
 * started from. The output is therefore never merely plausible: it is the one
 * file whose diff against these bytes is the diff that was approved.
 *
 * Returns null when the diff does not apply cleanly. That is an ordinary
 * outcome — a moved file, a rebased branch — and the caller reports it as a
 * skip, never as a patch.
 */
export function applyUnifiedDiff(original: string, diff: string): string | null {
  const source = splitLines(original);
  const lines = diff.split('\n');

  const out: string[] = [];
  let oldIndex = 0;
  /** Where a `+` line was marked as ending without a newline. */
  let addedNoNewlineAt = -1;
  /** Where the last line written by a `+` op landed. */
  let lastAddedAt = -1;
  let sawHunk = false;

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]!;

    if (raw.startsWith('--- ') || raw.startsWith('+++ ')) continue;

    if (raw.startsWith('@@')) {
      const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw);
      if (!header) return null;
      sawHunk = true;

      const oldStart = Number(header[1]);
      const oldCount = header[2] === undefined ? 1 : Number(header[2]);

      // A hunk of pure insertion names the line it goes *after*; every other
      // hunk names its first line. Both are 1-based.
      const target = oldCount === 0 ? oldStart : oldStart - 1;
      if (target < oldIndex || target > source.lines.length) return null;
      while (oldIndex < target) out.push(source.lines[oldIndex++]!);
      continue;
    }

    if (!sawHunk) continue;

    if (raw.startsWith('\\')) {
      // `\ No newline at end of file` describes the line just above it, on
      // whichever side that line belongs to.
      const previous = lines[i - 1];
      if (previous === undefined) return null;
      if (previous.startsWith('+')) addedNoNewlineAt = out.length - 1;
      // A marker on a `-` line describes the *old* file, which the original
      // bytes already answer. It says nothing about the new one.
      continue;
    }

    // Every body line carries its prefix, so a blank line here is not an empty
    // context line — it is the trailing element `split('\n')` leaves behind on
    // the diff's final newline. An empty context line is written as one space.
    if (raw === '') continue;

    const kind = raw[0];
    const text = raw.slice(1);

    if (kind === ' ') {
      if (source.lines[oldIndex] !== text) return null;
      out.push(text);
      oldIndex += 1;
    } else if (kind === '-') {
      if (source.lines[oldIndex] !== text) return null;
      oldIndex += 1;
    } else if (kind === '+') {
      out.push(text);
      lastAddedAt = out.length - 1;
    } else {
      return null;
    }
  }

  if (!sawHunk) return null;
  while (oldIndex < source.lines.length) out.push(source.lines[oldIndex++]!);

  /*
   * The terminator, from what the diff actually states about the *new* file.
   *
   * When the final line was written by a `+`, the diff is decisive both ways:
   * `unifiedDiff` marks that line when the new file ends without a newline, so
   * an unmarked one ends with a newline. When the final line is context instead,
   * the diff says nothing — and cannot, because a marker on a context line would
   * describe both sides at once — so the original's terminator is carried over,
   * which is right precisely because `unifiedDiff` forces a changed terminator
   * onto a `+` line rather than leaving it on context.
   */
  let trailingNewline = source.trailingNewline;
  if (out.length > 0 && lastAddedAt === out.length - 1) {
    trailingNewline = addedNoNewlineAt !== out.length - 1;
  }

  if (out.length === 0) return '';
  return trailingNewline ? `${out.join('\n')}\n` : out.join('\n');
}

/**
 * A `FilePatch` rebuilt from a stored diff and the file it was computed against.
 *
 * The diff is re-derived from the reconstructed contents and compared with the
 * one that came in. Equality is the whole point: `unifiedDiff` is deterministic,
 * so a result that does not reproduce its input byte for byte means the bytes on
 * hand are not the bytes the patch was written against, and the right answer is
 * to refuse rather than to commit something nobody reviewed.
 *
 * Returns null on any mismatch.
 */
export function rebuildFilePatch(
  filePath: string,
  originalContents: string,
  diff: string,
  details: {
    readonly findingIds?: readonly string[];
    readonly criteria?: readonly string[];
    readonly rationale?: string;
    readonly risk?: string | null;
  } = {},
): FilePatch | null {
  const newContents = applyUnifiedDiff(originalContents, diff);
  if (newContents === null) return null;

  // The hunks are compared, not the `--- a/… +++ b/…` header, so a stored path
  // that differs only in form — a backslash, a leading `./` — does not read as
  // a different change. Everything that decides the bytes is still exact.
  const recomputed = unifiedDiff(filePath, originalContents, newContents);
  if (stripDiffHeader(recomputed) !== stripDiffHeader(diff)) return null;

  return {
    filePath,
    newContents,
    originalContents,
    diff,
    findingIds: details.findingIds ?? [],
    criteria: details.criteria ?? [],
    rationale: details.rationale ?? '',
    risk: details.risk ?? null,
    stats: diffStats(diff),
  };
}

/** A diff without its `--- a/… +++ b/…` file header. */
function stripDiffHeader(diff: string): string {
  return diff
    .split('\n')
    .filter((line, index) => !(index < 2 && (line.startsWith('--- ') || line.startsWith('+++ '))))
    .join('\n');
}

/**
 * Split into lines without normalising anything.
 *
 * A carriage return stays part of the line it terminates. Stripping CRLF here
 * would be convenient and would also be a lie: a file rewritten from CRLF to LF
 * has different bytes, those bytes are what get committed, and a diff that
 * cancelled the change out would show a reviewer an empty hunk for a file that
 * really did change.
 */
function splitLines(text: string): { lines: string[]; trailingNewline: boolean } {
  if (text === '') return { lines: [], trailingNewline: true };
  const trailingNewline = text.endsWith('\n');
  const lines = text.split('\n');
  if (trailingNewline) lines.pop();
  return { lines, trailingNewline };
}

/**
 * The ops for a change that is only the file's final newline.
 *
 * Both sides have identical lines, so the LCS would call it "no change" and
 * print nothing. Forcing the last line through as a replacement lets the
 * `\ No newline at end of file` markers say which side lost its terminator,
 * which is what git does and what the bytes actually did.
 */
function lastLineReplacement(before: readonly string[], after: readonly string[]): DiffOp[] {
  const ops: DiffOp[] = [];
  const last = before.length - 1;
  for (let i = 0; i < last; i += 1) ops.push({ kind: ' ', line: before[i]! });
  if (last >= 0) {
    ops.push({ kind: '-', line: before[last]! });
    ops.push({ kind: '+', line: after[last]! });
  }
  return ops;
}

function changeRanges(ops: readonly DiffOp[], context: number): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i]!.kind === ' ') {
      i += 1;
      continue;
    }
    let end = i;
    let runOfContext = 0;
    let j = i;
    // Extend through changes, allowing up to 2*context unchanged lines between
    // them so nearby edits share one hunk.
    while (j < ops.length) {
      if (ops[j]!.kind === ' ') {
        runOfContext += 1;
        if (runOfContext > context * 2) break;
      } else {
        runOfContext = 0;
        end = j;
      }
      j += 1;
    }
    const start = Math.max(0, i - context);
    const stop = Math.min(ops.length - 1, end + context);
    const previous = ranges[ranges.length - 1];
    if (previous && start <= previous[1] + 1) previous[1] = Math.max(previous[1], stop);
    else ranges.push([start, stop]);
    i = end + 1;
  }
  return ranges;
}

/**
 * Longest-common-subsequence line diff.
 *
 * Common prefix and suffix are trimmed first, which is what keeps this cheap in
 * the case that actually happens: a large file with a handful of changed lines.
 * If the remaining window is still too big for the table, the whole window is
 * emitted as one replacement — an honest, if coarse, diff rather than a stall.
 */
function diffLines(before: readonly string[], after: readonly string[]): DiffOp[] {
  const ops: DiffOp[] = [];

  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) {
    ops.push({ kind: ' ', line: before[start]! });
    start += 1;
  }

  let endBefore = before.length;
  let endAfter = after.length;
  while (
    endBefore > start &&
    endAfter > start &&
    before[endBefore - 1] === after[endAfter - 1]
  ) {
    endBefore -= 1;
    endAfter -= 1;
  }

  const a = before.slice(start, endBefore);
  const b = after.slice(start, endAfter);

  if (a.length === 0 || b.length === 0 || (a.length + 1) * (b.length + 1) > LCS_CELL_CAP) {
    for (const line of a) ops.push({ kind: '-', line });
    for (const line of b) ops.push({ kind: '+', line });
  } else {
    ops.push(...lcsOps(a, b));
  }

  for (let i = endBefore; i < before.length; i += 1) {
    ops.push({ kind: ' ', line: before[i]! });
  }
  return ops;
}

function lcsOps(a: readonly string[], b: readonly string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const table = new Int32Array((n + 1) * width);

  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        a[i] === b[j]
          ? table[(i + 1) * width + (j + 1)]! + 1
          : Math.max(table[(i + 1) * width + j]!, table[i * width + (j + 1)]!);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: ' ', line: a[i]! });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * width + j]! >= table[i * width + (j + 1)]!) {
      ops.push({ kind: '-', line: a[i]! });
      i += 1;
    } else {
      ops.push({ kind: '+', line: b[j]! });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ kind: '-', line: a[i]! });
    i += 1;
  }
  while (j < m) {
    ops.push({ kind: '+', line: b[j]! });
    j += 1;
  }
  return ops;
}
