/**
 * The FIX prompt and the patch it produces (A5.2, A5.5).
 *
 * Two jobs, deliberately in one module because they are two halves of one
 * contract: `buildFixPrompt` states what the agent must return, and
 * `parseFixResponse` refuses anything that is not that.
 *
 * The agent never returns a diff. A model-authored unified diff has to be right
 * about line numbers and surrounding context before it can be right about
 * accessibility, and when it is wrong the failure is a patch that will not
 * apply — which the run discovers only in the sandbox. The diff shown to the
 * reviewer and stored in the ledger is computed here, from the file we gave the
 * agent and the file it gave back, so it is a true description of the change by
 * construction. That invariant is the whole point of this module and nothing
 * below weakens it.
 *
 * What the agent returns instead depends on the size of the file, and that is
 * the one thing here that was learned the hard way:
 *
 *  - **Small file — the whole new contents.** The simplest contract there is.
 *    The bytes are the bytes and the host diffs them.
 *
 *  - **Large file — a short list of exact string replacements.** Above
 *    `TARGETED_EDIT_LINE_THRESHOLD` a model cannot hand back the file it was
 *    given; it regenerates it from context, paraphrases what it could not hold,
 *    and returns something that reads like the original and is not. One real
 *    run on a 2,000-line component produced a diff of roughly two thousand
 *    deletions for a change that should have added `aria-pressed` to three
 *    buttons, with live calls replaced by an invented placeholder identifier,
 *    and every check of the day passed it: it was not empty, and it was not
 *    short enough to look truncated. Edits remove the opportunity — the model
 *    quotes only the lines it wants changed, `applyFixEdits` requires each
 *    quotation to occur exactly once, and every byte it did not quote is
 *    carried over by the host untouched.
 *
 * Three guards stand behind both contracts, because a contract is a request and
 * a guard is a fact: `findPlaceholderMarker` refuses a file that gained a
 * summary marker, `assessPatchSize` refuses a diff out of all proportion to the
 * findings it claims, and both produce a skip with a stated reason rather than
 * a patch. A patch like the one above reaching a pull request would destroy a
 * working application, so the default answer to a change that cannot be
 * accounted for is no.
 *
 * The provider-side half of the contract lives in `lib/harness/schemas.ts` as
 * `FILE_PATCH_RESPONSE_FORMAT` and `FILE_EDIT_RESPONSE_FORMAT`, because that is
 * what the saved FIX manifest is built from; the first is re-exported here as
 * `FIX_PATCH_RESPONSE_FORMAT` so there is exactly one description of a FIX
 * response in the codebase. There used to be two — the manifest asked for a
 * unified diff while this module asked for file contents — and the result was a
 * run that produced nothing and could not say why. The parser below still
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
  /**
   * The second contract, for a file too large to return whole
   * (`FILE_EDIT_RESPONSE_FORMAT`): the exact snippets to replace. Optional
   * here for the same reason `newContents` is — a response in the wrong shape
   * has to become a skip that says which shape it was in.
   */
  edits: z
    .array(z.preprocess(normalizeEditEntry, z.object({ find: z.string(), replace: z.string() })))
    .optional(),
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

/** Like `firstArray`, but absent stays absent so `.optional()` still means something. */
function firstArrayOrUndefined(
  source: Record<string, unknown>,
  keys: readonly string[],
): unknown[] | undefined {
  for (const key of keys) {
    const value = source[key];
    if (Array.isArray(value)) return value;
  }
  return undefined;
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
  const edits = firstArrayOrUndefined(raw, [
    'edits',
    'replacements',
    'stringReplacements',
    'string_replacements',
  ]);
  return {
    ...raw,
    filePath: firstString(raw, ['filePath', 'sourcePath', 'path', 'file']),
    newContents: firstString(raw, ['newContents', 'newContent', 'contents', 'content', 'source']),
    diff: firstString(raw, ['diff', 'patch', 'unifiedDiff', 'unified_diff']),
    rationale: firstString(raw, ['rationale', 'reason', 'explanation', 'why']),
    ...(edits === undefined ? {} : { edits }),
  };
}

/** The names a single edit has arrived under. Same rule: rename, never invent. */
function normalizeEditEntry(value: unknown): unknown {
  const raw = asRecord(value);
  return {
    ...raw,
    find: firstString(raw, [
      'find',
      'search',
      'old',
      'oldText',
      'old_text',
      'oldString',
      'old_string',
      'before',
    ]),
    replace: firstString(raw, [
      'replace',
      'replacement',
      'new',
      'newText',
      'new_text',
      'newString',
      'new_string',
      'after',
    ]),
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

/**
 * The OUTPUT section for a file small enough to hand back whole.
 *
 * Kept for exactly that case. When the model can hold the file, returning it is
 * the simplest contract there is — the bytes are the bytes, and the host diffs
 * them. It stops being simple the moment the file outgrows what the model can
 * reproduce, which is what `EDIT_OUTPUT_RULES` below exists for.
 */
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
 * The OUTPUT section for a file too large to hand back whole.
 *
 * Above `TARGETED_EDIT_LINE_THRESHOLD` the whole-file contract stops being a
 * contract the model can keep. It cannot copy two thousand lines; it
 * regenerates them, paraphrasing whatever it could not hold, and the result is
 * a file that reads like the original and is not. Asking instead for the few
 * snippets it wants changed removes the opportunity entirely: every byte it
 * does not quote is carried over by the host, because the host never asked for
 * it.
 *
 * The uniqueness rule is the load-bearing part. `applyFixEdits` matches each
 * \`find\` literally and requires exactly one occurrence; missing or ambiguous is
 * a skip with a reason, never a guess at which occurrence was meant.
 */
const EDIT_OUTPUT_RULES = `OUTPUT — TARGETED EDITS

This file is too large to return whole, and the schema you are held to does not accept a whole file. Return the exact string replacements that make your change, in \`edits\`.

- Each edit is { "find": "<snippet copied out of the file below>", "replace": "<that snippet after your change>" }.
- \`find\` is copied byte for byte out of the CURRENT CONTENTS block below: same indentation, same quotes, same line breaks, same trailing commas. It is matched literally. Nothing fuzzy-matches it, nothing repairs it, and a snippet you retyped from memory will not match.
- \`find\` must occur EXACTLY ONCE in that file. If the lines you want appear more than once, widen the snippet with the lines around it until it is unique. A \`find\` that is missing, or that occurs twice, is rejected and the findings stay open.
- Keep every \`find\` small: the lines you are changing, plus the least context that makes them unique. Never quote a whole component and never quote the whole file.
- \`replace\` is that same snippet after the change. An empty string deletes it. Never put an ellipsis, "unchanged", "rest of file" or any other placeholder inside \`find\` or \`replace\` — both are inserted as literal text.
- Edits apply in order, each one against the result of the one before it.
- Everything you do not quote is carried over untouched. You do not need to mention it and you must not try to.
- Prefer few, small edits. Three buttons that need the same attribute are three small edits, not one edit spanning the component.
- Change only what the findings require. Do not reformat, rename, restructure, upgrade a dependency or improve adjacent code. Do not change the visual design: an accessible name, a label association, a state binding, a keyboard handler or a focus style is in scope; a redesign is not.
- Keep the framework's idioms. If the file uses a design-system Button, keep using it. If the project has design tokens, change the token, not the component.
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

  /*
   * The prompt's contract and the parser's contract are one decision, taken
   * once from the file's size. `writePatches` asks the same function which
   * `response_format` to dispatch with, so the schema the model is held to and
   * the OUTPUT section it is reading cannot describe different shapes — which
   * is the exact divergence that cost this project a whole run once before.
   */
  const contract = chooseFixContract(fileContents);

  const header = [
    `FILE: ${group.filePath}`,
    options.repoFullName ? `REPOSITORY: ${options.repoFullName}` : null,
    options.ref ? `REF: ${options.ref}` : null,
    `SIZE: ${lineCount(fileContents)} lines`,
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
    contract === 'targeted-edits' ? EDIT_OUTPUT_RULES : OUTPUT_RULES,
    '',
    options.projectNotes ? `PROJECT NOTES\n\n${options.projectNotes}\n` : '',
    `CURRENT CONTENTS OF ${group.filePath}`,
    '',
    contract === 'targeted-edits'
      ? 'Every `find` you send must be copied out of this block exactly as it appears here.'
      : '',
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
/* Which contract this file gets                                              */
/* -------------------------------------------------------------------------- */

/**
 * Above this many lines, FIX is asked for targeted edits instead of the whole
 * file.
 *
 * The number is not a performance knob. A model asked to hand back two thousand
 * lines does not copy them — they are not in a buffer it can memcpy — it
 * regenerates them from context, and what comes back is a file that is
 * *plausible* rather than *identical*. A real run on a 2,000-line component
 * produced a diff of roughly two thousand deletions for a change that should
 * have added `aria-pressed` to three buttons, with live calls replaced by an
 * invented placeholder identifier. The whole-file contract is fine for a file a
 * model can hold and actively dangerous for one it cannot.
 *
 * 400 lines is well inside the range that comes back faithfully and well below
 * where paraphrasing starts. Under it, the whole-file path is kept — it has the
 * simplest failure mode there is, "the bytes are the bytes".
 */
export const TARGETED_EDIT_LINE_THRESHOLD = 400;

/** The two shapes a FIX answer may take. */
export type FixContract = 'whole-file' | 'targeted-edits';

/** Number of lines in a string, counting a final line without a terminator. */
function lineCount(text: string): number {
  if (text === '') return 0;
  const n = text.split('\n').length;
  return text.endsWith('\n') ? n - 1 : n;
}

/**
 * Which contract a file of this size gets. Called by `buildFixPrompt` to write
 * the OUTPUT section, by `writePatches` to choose the response format, and by
 * `parseFixResponse` to decide what it is reading — one function, so the three
 * cannot disagree about a file.
 */
export function chooseFixContract(fileContents: string): FixContract {
  return lineCount(fileContents) > TARGETED_EDIT_LINE_THRESHOLD
    ? 'targeted-edits'
    : 'whole-file';
}

/* -------------------------------------------------------------------------- */
/* Placeholder corruption                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The tells that a model summarised the file instead of reproducing it.
 *
 * Each has been produced by a real model asked for a file it could not hold: a
 * marker where a block used to be, a comment saying the rest is unchanged, a
 * bare ellipsis standing in for a hundred lines. Every one of them compiles to
 * *something*, which is what makes them dangerous — a truncated file is
 * obvious, a summarised one looks like code.
 */
const PLACEHOLDER_MARKERS: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: 'REDACTED', pattern: /\bREDACTED\b/g },
  {
    label: '"... rest of file ..."',
    pattern: /(?:\.{3}|…)[^\n]{0,40}\brest of (?:the )?(?:file|code|component|imports)\b/gi,
  },
  { label: '"rest unchanged"', pattern: /\brest (?:of [^\n]{0,40})?(?:is |are )?unchanged\b/gi },
  {
    label: '"// unchanged"',
    pattern: /^[ \t]*(?:\/\/|#|--)[ \t]*(?:\.{3}|…)?[ \t]*(?:rest[ \t]+)?unchanged\b[^\n]*$/gim,
  },
  {
    label: '"/* unchanged */"',
    pattern: /\{?\/\*[ \t]*(?:\.{3}|…)?[ \t]*(?:rest[ \t]+)?unchanged[^*]{0,60}\*\/\}?/gi,
  },
  {
    label: '"/* ... */" standing alone',
    pattern: /^[ \t]*\{?[ \t]*\/\*[ \t]*(?:\.{3}|…)[ \t]*\*\/[ \t]*\}?[ \t]*,?[ \t]*$/gm,
  },
  { label: '"<!-- ... -->"', pattern: /<!--[ \t]*(?:\.{3}|…)[^>]{0,60}-->/g },
  {
    label: 'a line that is only an ellipsis',
    pattern: /^[ \t]*(?:\/\/[ \t]*|#[ \t]*)?(?:\.{3}|…)[ \t]*,?[ \t]*$/gm,
  },
  {
    label: '"code omitted"',
    pattern:
      /\b(?:remaining|existing|unchanged|other)[^\n]{0,30}\b(?:code|lines|imports|functions|components|handlers|helpers)\b[^\n]{0,20}\b(?:omitted|elided|truncated|snipped|unchanged)\b/gi,
  },
  { label: '"for brevity"', pattern: /\bfor brevity\b/gi },
  {
    label: '"same as before"',
    pattern: /^[ \t]*(?:\/\/|\/\*|\{\/\*|#)[^\n]{0,20}\bsame as (?:before|above|the original)\b[^\n]*$/gim,
  },
  {
    label: 'an implementation placeholder',
    pattern: /\b(?:YOUR_CODE_HERE|IMPLEMENTATION_HERE|CODE_HERE|TODO: (?:restore|keep|reinsert))\b/g,
  },
];

/** A marker the returned file has and the file we sent did not. */
export interface PlaceholderHit {
  /** Human name of the marker, for the skip reason. */
  readonly marker: string;
  /** The line it appeared on, trimmed. */
  readonly sample: string;
  /** 1-based line in the returned file. */
  readonly line: number;
  readonly countBefore: number;
  readonly countAfter: number;
}

function countMatches(text: string, pattern: RegExp): { count: number; first: number } {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const re = new RegExp(pattern.source, flags);
  let count = 0;
  let first = -1;
  for (;;) {
    const match = re.exec(text);
    if (match === null) break;
    if (first === -1) first = match.index;
    count += 1;
    if (match[0].length === 0) re.lastIndex += 1;
  }
  return { count, first };
}

/**
 * The first sign the returned file was summarised rather than reproduced.
 *
 * A marker only counts as corruption if the file *gained* it. That qualifier is
 * not timidity — the very file this guard was written for legitimately contains
 * a helper named `REDACTED`, and a detector firing on mere presence would refuse
 * every honest patch to it forever. What the corrupt run did was delete real
 * calls and leave the marker behind, and the count is what shows that: markers
 * the file already carried are its own, markers it did not are the model's.
 */
export function findPlaceholderMarker(before: string, after: string): PlaceholderHit | null {
  for (const { label, pattern } of PLACEHOLDER_MARKERS) {
    const countBefore = countMatches(before, pattern).count;
    const hit = countMatches(after, pattern);
    if (hit.count <= countBefore) continue;

    const line = after.slice(0, hit.first).split('\n').length;
    const sample = (after.split('\n')[line - 1] ?? '').trim().slice(0, 120);
    return { marker: label, sample, line, countBefore, countAfter: hit.count };
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Proportionality                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The most of a file one accessibility patch may rewrite, as a fraction of its
 * lines.
 *
 * A remediation is a surgical change: an attribute bound to state, a label
 * associated with an input, a colour token adjusted. Whatever else a diff
 * touching a quarter of a file is, it is not that — and the reviewer who would
 * have to read it is exactly the person this guard protects.
 */
export const MAX_CHANGED_LINE_FRACTION = 0.25;

/**
 * Changed lines allowed per finding the patch claims, before the fraction rule
 * is consulted. `aria-pressed` on a button is two lines; a keyboard handler with
 * a focus style is a dozen. Twenty is generous for the honest case and nowhere
 * near a rewrite.
 */
export const CHANGED_LINES_PER_FINDING = 20;

/** Slack on top of the per-finding budget, for an import and a wired-through prop. */
export const CHANGED_LINE_BASE_ALLOWANCE = 10;

/**
 * No patch is refused for size below this many changed lines. A 40-line file has
 * no room for a quarter-of-the-file rule, and refusing a 12-line fix to a
 * 30-line component would be the guard doing the harm.
 */
export const MIN_CHANGED_LINE_ALLOWANCE = 30;

/**
 * Lines a patch may delete beyond what it adds.
 *
 * An accessibility fix nearly always grows a file: an attribute, a handler, a
 * label. It shrinks one only when it collapses something — a div-plus-role
 * scaffold replaced by a real `<button>` — and that is worth a handful of lines,
 * not a hundred. Net deletion at scale means content went missing, and missing
 * content is what a summarised file looks like from the diff's side.
 */
export const MAX_EXCESS_DELETED_LINES = 10;

export interface PatchSizeVerdict {
  readonly ok: boolean;
  /** Present when `ok` is false. Used as the skip reason, verbatim. */
  readonly reason?: string;
  readonly changedLines: number;
  readonly allowance: number;
  readonly fileLines: number;
}

/**
 * Is this diff the size of the fix it claims to be?
 *
 * Run on the host, against the host's own diff, after the bytes are settled — so
 * it measures what a reviewer would actually see rather than what the model said
 * it did. Two independent rules, and either one refusing is a skip:
 *
 *  1. **Volume.** Changed lines are capped by the smaller of a per-finding
 *     budget and a fraction of the file, floored so small files are never
 *     squeezed. A three-button `aria-pressed` fix costs single digits; the
 *     corrupt run that motivated this cost four thousand.
 *  2. **Net deletion.** Removing much more than you add is how a summarised file
 *     shows up in a diff, and it is not how a remediation behaves.
 *
 * Refusing is not a failure of the run. The finding stays open with a reason a
 * human can read, which is the whole product: the patch this exists to stop
 * would otherwise have reached a pull request and destroyed a working
 * application.
 */
export function assessPatchSize(input: {
  readonly filePath: string;
  readonly originalContents: string;
  readonly stats: PatchStats;
  /** How many findings the patch says it addresses. Never zero at the call site. */
  readonly findingCount: number;
}): PatchSizeVerdict {
  const fileLines = Math.max(1, lineCount(input.originalContents));
  const changedLines = input.stats.linesAdded + input.stats.linesRemoved;
  const claimed = Math.max(1, input.findingCount);

  const perFinding = CHANGED_LINE_BASE_ALLOWANCE + claimed * CHANGED_LINES_PER_FINDING;
  const fraction = Math.ceil(fileLines * MAX_CHANGED_LINE_FRACTION);
  const allowance = Math.max(MIN_CHANGED_LINE_ALLOWANCE, Math.min(perFinding, fraction));
  const base = { changedLines, allowance, fileLines };

  if (changedLines > allowance) {
    const percent = Math.round((changedLines / fileLines) * 100);
    return {
      ...base,
      ok: false,
      reason:
        `FIX returned a change to ${input.filePath} that rewrites ${changedLines} lines ` +
        `(${input.stats.linesAdded} added, ${input.stats.linesRemoved} removed) of a ` +
        `${fileLines}-line file — about ${percent}% of it — for ${claimed} finding` +
        `${claimed === 1 ? '' : 's'}. An accessibility remediation of that size is not a ` +
        `remediation; the budget for this patch was ${allowance} changed lines. Almost always ` +
        'this is a large file the model regenerated from memory rather than edited, which ' +
        'silently paraphrases whatever it could not hold. Rejected rather than put in front of ' +
        'a reviewer — the findings stay open.',
    };
  }

  const excessDeleted = input.stats.linesRemoved - input.stats.linesAdded;
  if (excessDeleted > MAX_EXCESS_DELETED_LINES) {
    return {
      ...base,
      ok: false,
      reason:
        `FIX returned a change to ${input.filePath} that deletes ${excessDeleted} more lines ` +
        `than it adds (${input.stats.linesRemoved} removed against ${input.stats.linesAdded} ` +
        'added). An accessibility fix adds an attribute, a label or a handler; it does not net ' +
        `out at ${excessDeleted} lines of working code removed, and at most ` +
        `${MAX_EXCESS_DELETED_LINES} are allowed. Rejected — the findings stay open.`,
    };
  }

  return { ...base, ok: true };
}

/* -------------------------------------------------------------------------- */
/* Targeted edits                                                             */
/* -------------------------------------------------------------------------- */

/** One exact string replacement, applied on the host. */
export interface FixEdit {
  readonly find: string;
  readonly replace: string;
}

/** Edits accepted for one file. More than this is a rewrite wearing a costume. */
export const MAX_EDITS_PER_FILE = 24;

/** Lines one `find` snippet may span. Enough for a JSX element, not a component. */
export const MAX_EDIT_FIND_LINES = 80;

export type ApplyEditsResult =
  | { readonly ok: true; readonly contents: string; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly reason: string };

function occurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
}

/** A snippet, shortened for a skip reason a human has to read in a list. */
function excerpt(text: string, max = 90): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length <= max ? single : `${single.slice(0, max)}…`;
}

/**
 * Apply a model's edit list to the exact bytes we sent it.
 *
 * Every `find` must occur **exactly once** in the text as it stands when that
 * edit runs. Zero occurrences means the model quoted something that is not there
 * — usually because it retyped the snippet rather than copying it — and two
 * occurrences mean it does not know which one it meant. Both are refused by
 * name. Nothing here fuzzy-matches and nothing picks "the first one": a silent
 * wrong choice inside somebody's component is exactly the outcome this module
 * exists to prevent.
 *
 * The one repair allowed is line terminators. A model shown a CRLF file answers
 * in LF as often as not; converting the snippet's newlines and *still* requiring
 * the converted form to be uniquely present changes no other byte and cannot
 * select a different site. That is a rename, not an invention.
 *
 * Edits apply in order, each against the result of the last, so a later edit may
 * legitimately depend on an earlier one — and a `find` made ambiguous by an
 * earlier `replace` is caught rather than guessed at.
 */
export function applyFixEdits(original: string, edits: readonly FixEdit[]): ApplyEditsResult {
  if (edits.length === 0) {
    return {
      ok: false,
      reason: 'FIX returned an empty `edits` list, so there is nothing to apply.',
    };
  }
  if (edits.length > MAX_EDITS_PER_FILE) {
    return {
      ok: false,
      reason:
        `FIX returned ${edits.length} edits for one file, above the limit of ` +
        `${MAX_EDITS_PER_FILE}. That is a rewrite expressed as replacements, not a remediation.`,
    };
  }

  const warnings: string[] = [];
  let working = original;

  for (let i = 0; i < edits.length; i += 1) {
    const edit = edits[i]!;
    const label = `edit ${i + 1} of ${edits.length}`;

    if (edit.find.length === 0) {
      return {
        ok: false,
        reason: `FIX returned ${label} with an empty \`find\`, which matches nothing.`,
      };
    }
    if (lineCount(edit.find) > MAX_EDIT_FIND_LINES) {
      return {
        ok: false,
        reason:
          `FIX returned ${label} whose \`find\` spans ${lineCount(edit.find)} lines, above the ` +
          `limit of ${MAX_EDIT_FIND_LINES}. A snippet that large is the whole file arriving by ` +
          'another route, and it is the shape that gets paraphrased. Quote only the lines you change.',
      };
    }
    if (edit.find === edit.replace) {
      warnings.push(
        `FIX returned ${label} whose \`replace\` is identical to its \`find\`; it changed nothing.`,
      );
      continue;
    }

    let find = edit.find;
    let replace = edit.replace;
    let found = occurrences(working, find);

    if (found === 0) {
      // Terminators only. Same characters, same site, different line endings.
      const crlf = find.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
      const lf = find.replace(/\r\n/g, '\n');
      const candidates: readonly (readonly [string, 'CRLF' | 'LF'])[] = [
        [crlf, 'CRLF'],
        [lf, 'LF'],
      ];
      for (const [candidate, style] of candidates) {
        if (candidate === find) continue;
        if (occurrences(working, candidate) !== 1) continue;
        warnings.push(
          `FIX quoted ${label} with line endings that do not match the file; it was matched ` +
            `after converting the snippet to ${style}. No other byte was changed.`,
        );
        find = candidate;
        replace =
          style === 'CRLF'
            ? replace.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n')
            : replace.replace(/\r\n/g, '\n');
        found = 1;
        break;
      }
    }

    if (found === 0) {
      return {
        ok: false,
        reason:
          `FIX asked to replace a snippet that does not appear in the file (${label}): ` +
          `"${excerpt(edit.find)}". Nothing was applied and nothing was guessed at.`,
      };
    }
    if (found > 1) {
      return {
        ok: false,
        reason:
          `FIX asked to replace a snippet that appears ${found} times in the file (${label}): ` +
          `"${excerpt(edit.find)}". An ambiguous edit is refused rather than applied to whichever ` +
          'occurrence happened to come first.',
      };
    }

    const at = working.indexOf(find);
    working = working.slice(0, at) + replace + working.slice(at + find.length);
  }

  return { ok: true, contents: working, warnings };
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
  // The same decision `buildFixPrompt` took when it wrote the OUTPUT section, taken
  // again from the same bytes rather than passed along, so a caller cannot parse a
  // response against a contract the agent was never given.
  const contract = chooseFixContract(originalContents);

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
     * Which of the three shapes came back, and the bytes it means.
     *
     * `edits` is what a large file is asked for and `newContents` is what a
     * small one is asked for, but either may arrive under either contract — a
     * model held to a stale manifest, a session that answered in the shape it
     * knew. Both are accepted and both are then held to the same guards below,
     * because the guards are about the bytes, not about which key carried them.
     *
     * A unified diff is accepted too, for the same reason it always was: a
     * manifest still pinned to the old `accessifix_patch_set` shape constrains
     * the model to answer with one, and throwing it away is how a run ends up
     * with nothing to show and nothing to say. Accepting it does not weaken the
     * rule that the host owns the diff — `applyUnifiedDiff` checks every context
     * and every removed line against the exact bytes we sent, so a diff
     * describing some other file cannot apply at all, and the diff we store is
     * still recomputed further down from the bytes on both ends.
     */
    let newContents: string | undefined;

    const editList = file.edits;
    if (editList !== undefined && editList.length > 0) {
      if (contract === 'whole-file') {
        warnings.push(
          `FIX answered with ${editList.length} targeted edit(s) for ${group.filePath} where ` +
            'whole contents were asked for. They were applied on the host, which is the safer ' +
            'of the two, so the patch stands.',
        );
      }
      const applied = applyFixEdits(originalContents, editList);
      if (!applied.ok) {
        skipped.push({
          findingIds: group.findingIds,
          criterion: null,
          reason: `${applied.reason} The findings stay open.`,
        });
        continue;
      }
      warnings.push(...applied.warnings);
      newContents = applied.contents;
    } else if (typeof file.newContents === 'string') {
      if (contract === 'targeted-edits') {
        warnings.push(
          `FIX returned whole contents for ${group.filePath}, which is ${lineCount(originalContents)} ` +
            'lines and was asked for targeted edits. A file that size is regenerated rather than ' +
            'copied, so the answer was accepted only provisionally and is held to the ' +
            'placeholder and proportionality checks below.',
        );
      }
      newContents = file.newContents;
    } else if (typeof file.diff === 'string' && file.diff.trim().length > 0) {
      const applied = applyUnifiedDiff(originalContents, file.diff);
      if (applied === null) {
        skipped.push({
          findingIds: group.findingIds,
          criterion: null,
          reason:
            `FIX answered with a unified diff for ${group.filePath} rather than the shape the ` +
            'prompt asked for, and the diff does not apply to the bytes that were sent. It was ' +
            'rejected rather than guessed at. The saved FIX manifest is out of date; re-register ' +
            'it with `npm run agents:init -- --update`.',
        });
        continue;
      }
      warnings.push(
        `FIX returned a diff for ${group.filePath} instead of the shape the prompt asked for. ` +
          'It applied cleanly to the bytes we sent, so the patch was rebuilt from the result.',
      );
      newContents = applied;
    } else {
      skipped.push({
        findingIds: group.findingIds,
        criterion: null,
        reason:
          `FIX returned an entry for ${group.filePath} carrying no \`${
            contract === 'targeted-edits' ? 'edits' : 'newContents'
          }\`, no contents and no diff, so there is nothing to apply. The findings stay open.`,
      });
      continue;
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

    /*
     * Did the model reproduce the file, or describe it?
     *
     * A truncated file is caught above by length. A *summarised* one is not: it
     * is the right size, it parses, and somewhere in the middle a working block
     * has become `// ... unchanged ...` or a live call has become a placeholder
     * identifier. That is the shape a large-file rewrite actually fails in, and
     * it reaches a reviewer looking like ordinary code.
     *
     * Only markers the file *gained* count, which is what lets this run against
     * a file that legitimately contains one of these words.
     */
    const placeholder = findPlaceholderMarker(originalContents, newContents);
    if (placeholder !== null) {
      skipped.push({
        findingIds: group.findingIds,
        criterion: null,
        reason:
          `FIX returned ${group.filePath} containing ${placeholder.marker} at line ` +
          `${placeholder.line} — "${placeholder.sample}" — which the file it was given does not ` +
          `have (${placeholder.countBefore} before, ${placeholder.countAfter} after). That is a ` +
          'summary of the file standing in for the file: the model wrote a placeholder where ' +
          'real code used to be. Rejected outright — the findings stay open.',
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
    const stats = diffStats(diff);

    /*
     * The last gate, and the one that would have caught the run this was
     * written for: is the change the size of the fix it claims to be?
     *
     * It is measured here, on the host's own diff, because that is the only
     * number that is not the model's opinion — the same bytes a reviewer would
     * read and the same bytes that would land in the commit. `aria-pressed` on
     * three buttons is single digits of changed lines. Two thousand deletions
     * for the same claim is not a bigger version of that fix; it is a different
     * change nobody proposed, and it reached a pull request once.
     */
    const size = assessPatchSize({
      filePath: group.filePath,
      originalContents,
      stats,
      findingCount: findingIds.length,
    });
    if (!size.ok) {
      skipped.push({
        findingIds: group.findingIds,
        criterion: null,
        reason: size.reason ?? `FIX returned a disproportionate change to ${group.filePath}.`,
      });
      continue;
    }

    patches.push({
      filePath: group.filePath,
      newContents,
      originalContents,
      diff,
      findingIds,
      criteria: criteria.length > 0 ? criteria : criteriaOf(group, findingIds),
      rationale: file.rationale,
      risk: file.risk ?? null,
      stats,
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
