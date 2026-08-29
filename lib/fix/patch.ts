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
 * Note that this diverges from `PatchSchema` in `lib/harness/schemas.ts`, which
 * asks the saved FIX manifest for a diff. Use `FIX_PATCH_RESPONSE_FORMAT` from
 * this module when dispatching with the prompt this module builds.
 */

import { z } from 'zod';

import type { FixGroup, GroupedFinding } from './group';

/**
 * The `response_format` shape TrueForge accepts, declared structurally rather
 * than imported. It is four lines, and this module has no other reason to
 * depend on the harness.
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
  newContents: z.string(),
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
 */
export const FixResponseSchema = z.object({
  files: z.array(z.preprocess(normalizeFileEntry, RawFileSchema)).default([]),
  skipped: z.array(z.preprocess(normalizeSkippedEntry, RawSkippedSchema)).default([]),
});

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

function normalizeFileEntry(value: unknown): unknown {
  const raw = asRecord(value);
  return {
    ...raw,
    filePath: firstString(raw, ['filePath', 'sourcePath', 'path', 'file']),
    newContents: firstString(raw, ['newContents', 'newContent', 'contents', 'content', 'source']),
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

const NULLABLE_STRING = { type: ['string', 'null'] } as const;

/**
 * `response_format` for a FIX turn dispatched with `buildFixPrompt`.
 *
 * Pass this on an inline agent spec — the saved FIX manifest asks for diffs and
 * would constrain the model to the wrong shape.
 */
export const FIX_PATCH_RESPONSE_FORMAT: JsonSchemaResponseFormat = {
  type: 'json_schema',
  json_schema: {
    name: 'accessifix_file_patch',
    description:
      'The complete new contents of each file changed, with the findings each change addresses.',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['files', 'skipped'],
      properties: {
        files: {
          type: 'array',
          description: 'One entry for the file you were given. Empty if you changed nothing.',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['filePath', 'newContents', 'criteria', 'findingIds', 'rationale', 'risk'],
            properties: {
              filePath: {
                type: 'string',
                description: 'Repository-relative path, exactly as it was given to you.',
              },
              newContents: {
                type: 'string',
                description:
                  'The complete file after your change. Every line, first to last. Never an excerpt, never a diff, never an ellipsis.',
              },
              criteria: {
                type: 'array',
                items: { type: 'string' },
                description: 'WCAG success criterion numbers this change addresses.',
              },
              findingIds: {
                type: 'array',
                items: { type: 'string' },
                description: 'Ids of the findings this change addresses, from the list given.',
              },
              rationale: {
                type: 'string',
                description: 'Why the change is correct, in prose a reviewer can check.',
              },
              risk: { ...NULLABLE_STRING, description: 'What it might break, or null.' },
            },
          },
        },
        skipped: {
          type: 'array',
          description: 'Findings you deliberately did not fix, each with a real reason.',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['criterion', 'findingIds', 'reason'],
            properties: {
              criterion: NULLABLE_STRING,
              findingIds: { type: 'array', items: { type: 'string' } },
              reason: { type: 'string' },
            },
          },
        },
      },
    },
  },
};

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

  const parsed = FixResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new FixResponseError(
      `FIX response for ${group.filePath} does not match the schema: ${formatIssues(parsed.error)}`,
      typeof raw === 'string' ? raw : undefined,
      parsed.error,
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

  for (const file of parsed.data.files) {
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

    if (file.newContents.trim().length === 0) {
      skipped.push({
        findingIds: group.findingIds,
        criterion: null,
        reason: `FIX returned an empty file for ${group.filePath}. Rejected — an accessibility fix never deletes a file.`,
      });
      continue;
    }

    if (file.newContents === originalContents) {
      skipped.push({
        findingIds: group.findingIds,
        criterion: null,
        reason: `FIX returned ${group.filePath} unchanged, so there is nothing to review. The findings stay open.`,
      });
      continue;
    }

    if (looksTruncated(originalContents, file.newContents, minRatio)) {
      skipped.push({
        findingIds: group.findingIds,
        criterion: null,
        reason:
          `FIX returned ${group.filePath} at ${file.newContents.length} characters against an ` +
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
      file.newContents,
      options.diffContext ?? 3,
    );

    patches.push({
      filePath: group.filePath,
      newContents: file.newContents,
      originalContents,
      diff,
      findingIds,
      criteria: criteria.length > 0 ? criteria : criteriaOf(group, findingIds),
      rationale: file.rationale,
      risk: file.risk ?? null,
      stats: diffStats(diff),
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

function looksTruncated(before: string, after: string, minRatio: number): boolean {
  if (before.length < 200) return false;
  if (after.length >= before.length * minRatio) return false;
  return true;
}

/**
 * Which findings a patch addresses. The agent's own list is preferred; when it
 * gave none, the criteria it named are mapped back onto the group's findings;
 * when it named neither, the patch covers every finding in the file, because
 * that is what it was asked to fix.
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

  return [...group.findingIds];
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
  const ops = diffLines(beforeLines.lines, afterLines.lines);

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

function splitLines(text: string): { lines: string[]; trailingNewline: boolean } {
  if (text === '') return { lines: [], trailingNewline: true };
  const normalized = text.replace(/\r\n/g, '\n');
  const trailingNewline = normalized.endsWith('\n');
  const lines = normalized.split('\n');
  if (trailingNewline) lines.pop();
  return { lines, trailingNewline };
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
