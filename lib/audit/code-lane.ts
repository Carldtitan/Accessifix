/**
 * The CODE lane: three criteria that do not exist in the rendered page.
 *
 * 2.5.1 Pointer Gestures, 2.5.4 Motion Actuation and 2.5.7 Dragging Movements
 * are all about what happens when the user does something — swipes, tilts the
 * phone, drags a handle. None of it is in the DOM. A carousel driven entirely
 * by `touchmove` renders as a `div`; the accessibility tree has nothing to say
 * about it, axe has no rule for it, and driving it in a headless browser tells
 * you only that a click did nothing. The handler is the evidence, and the
 * handler is in the repository.
 *
 * ---------------------------------------------------------------------------
 * THE SOURCE HAS TO COME FROM SOMEWHERE
 *
 * The conductor dispatches per-page lanes with a page and its capture, and a
 * capture does not carry a repository. So this lane accepts source three ways,
 * in order of directness:
 *
 *   - `sources`, files a caller already holds;
 *   - `repo`, read through the signed-in user's own GitHub token (A1.4);
 *   - neither, which is the ordinary conductor path today.
 *
 * With neither, it returns all three criteria inconclusive with that stated. It
 * does not return an empty findings list and let the score print three passes:
 * "no gesture handler was found" and "nobody looked for one" are the same shape
 * on the page and opposite in meaning, and only one of them is true here.
 *
 * ---------------------------------------------------------------------------
 * THE MODEL READS EXCERPTS, NOT REPOSITORIES
 *
 * A repository is far larger than a context window and almost none of it is
 * about gestures. `findGestureSignals` below does the search deterministically —
 * a line-level scan for the handler names, event types and library imports that
 * these three criteria are about — and only the files that matched are sent, as
 * numbered excerpts around each hit. That keeps the pass affordable, keeps
 * artifacts out of context (A9.2, A13.7), and gives every finding a real
 * `sourcePath` with a line number, which is what FIX groups on (A5.2).
 *
 * The scan finds candidates; it never files a finding. "There is a `touchmove`
 * handler here" is not a violation — the violation is the *absence of a
 * single-pointer alternative*, and judging that means reading the component.
 * That is the model's job, and the reason these three criteria are FLAG.
 */

import { renderCriterionTable } from '@/lib/harness/criteria';

import { resolveLaneCapabilities, type LaneCapabilityOptions } from './lane-context';
import {
  describe as describeError,
  inconclusiveResult,
  lanePolicy,
  runFindingsAgent,
  toClaims,
  truncate,
  type LaneInconclusive,
  type ModelLaneResult,
} from './model-lane';
import type { AuditPhase } from './types';

/* ========================================================================== */
/* Lane policy                                                                */
/* ========================================================================== */

/** 2.5.1, 2.5.4 and 2.5.7, from the roster, checked against the criteria table. */
export const CODE_POLICY = lanePolicy('code', 'CODE');

/* -- Build-time proof this lane really is FLAG-only ------------------------ */
{
  if (CODE_POLICY.verdicts.length !== 1 || CODE_POLICY.verdicts[0] !== 'FLAG') {
    throw new Error(
      `CODE must be FLAG-only; the roster allows ${CODE_POLICY.verdicts.join(', ')}`,
    );
  }
}

/* ========================================================================== */
/* The deterministic scan                                                     */
/* ========================================================================== */

/** Files worth opening. Anything else is not a component. */
const SOURCE_EXTENSIONS: readonly string[] = [
  '.tsx',
  '.ts',
  '.jsx',
  '.js',
  '.mjs',
  '.vue',
  '.svelte',
  '.astro',
];

/** Directories that are never the application's own source. */
const SKIP_SEGMENTS: readonly string[] = [
  'node_modules/',
  '.next/',
  'dist/',
  'build/',
  'out/',
  'coverage/',
  '.git/',
  'vendor/',
  '__snapshots__/',
];

const SKIP_FILE_PATTERN = /\.(d\.ts|min\.js|test\.[tj]sx?|spec\.[tj]sx?)$/i;

/** Largest single file the scan will read. Bundles are not components. */
const MAX_SOURCE_BYTES = 400_000;

/** Files sent to the model after the scan, worst first. */
export const MAX_CODE_FILES = 24;

/** Lines of context either side of a hit. */
const EXCERPT_RADIUS = 8;

export type GestureCriterion = '2.5.1' | '2.5.4' | '2.5.7';

/**
 * What each criterion looks like in source.
 *
 * Deliberately name-level rather than clever: these patterns decide which files
 * a model reads, and a regex that tries to understand the code will miss the
 * hand-rolled case that matters most. False positives here cost a few tokens;
 * a false negative costs the criterion.
 */
export const GESTURE_SIGNALS: Readonly<Record<GestureCriterion, RegExp>> = {
  // Multipoint or path-based gestures, and the libraries that provide them.
  '2.5.1':
    /\b(touchmove|ontouchmove|touchstart|gesturestart|gesturechange|gestureend|onPinch|pinchZoom|onRotate|onSwipe|swipeable|swiper|hammerjs|Hammer|useGesture|@use-gesture|react-swipeable|keen-slider|embla-carousel|onPanStart|onPan\b|panGesture)\b/i,
  // Motion actuation: the device sensors and the permission dance around them.
  '2.5.4':
    /\b(devicemotion|deviceorientation|DeviceMotionEvent|DeviceOrientationEvent|requestPermission\(\s*\)|Accelerometer|LinearAccelerationSensor|Gyroscope|AbsoluteOrientationSensor|shakeThreshold|onShake|useDeviceOrientation|useDeviceMotion)\b/i,
  // Dragging: HTML5 drag events, pointer-based reordering, and the DnD libraries.
  '2.5.7':
    /\b(dragstart|ondragstart|dragover|ondragover|dragend|ondragend|draggable\s*[=:]|onDragStart|onDragEnd|onDrop|react-dnd|@dnd-kit|dnd-kit|react-beautiful-dnd|sortablejs|react-sortablejs|useDraggable|useSortable|Draggable\b|interact\.js|pointerdown)\b/i,
};

/**
 * Signals that a single-pointer alternative may already exist in the same file.
 *
 * Not a verdict — the model decides whether the alternative is equivalent. This
 * exists so the excerpt it reads contains the answer as often as possible, and
 * so the prompt can honestly say "look for the alternative before you report".
 */
const ALTERNATIVE_SIGNAL =
  /\b(onKeyDown|onKeyUp|onKeyPress|keydown|ArrowLeft|ArrowRight|ArrowUp|ArrowDown|<button|role\s*=\s*["']button["']|onClick|aria-label|tabIndex|prefers-reduced-motion|moveUp|moveDown|stepUp|stepDown)\b/;

export interface SourceFile {
  /** Repository-relative. Goes straight into `sourcePath`. */
  readonly path: string;
  readonly content: string;
}

export interface GestureHit {
  readonly criterion: GestureCriterion;
  readonly line: number;
  readonly text: string;
}

export interface ScannedFile {
  readonly path: string;
  readonly hits: readonly GestureHit[];
  /** Numbered excerpts around every hit, merged where they overlap. */
  readonly excerpt: string;
  /** Whether the same file contains anything that looks like an alternative. */
  readonly hasAlternativeSignal: boolean;
}

export interface GestureScan {
  readonly files: readonly ScannedFile[];
  readonly filesScanned: number;
  /** Criteria at least one file matched. */
  readonly criteriaSeen: readonly GestureCriterion[];
}

/** True when a path is worth opening at all. */
export function isScannableSource(path: string): boolean {
  const lowered = path.toLowerCase();
  if (SKIP_SEGMENTS.some((segment) => lowered.includes(segment))) return false;
  if (SKIP_FILE_PATTERN.test(lowered)) return false;
  return SOURCE_EXTENSIONS.some((extension) => lowered.endsWith(extension));
}

/**
 * Find every line that looks like a gesture, motion or drag handler.
 *
 * Pure, and exported so the scan can be exercised on a literal without a
 * repository.
 */
export function findGestureSignals(sources: readonly SourceFile[]): GestureScan {
  const files: ScannedFile[] = [];
  const criteriaSeen = new Set<GestureCriterion>();
  let scanned = 0;

  for (const source of sources) {
    if (!isScannableSource(source.path)) continue;
    if (source.content.length > MAX_SOURCE_BYTES) continue;
    scanned += 1;

    const lines = source.content.split(/\r?\n/);
    const hits: GestureHit[] = [];

    for (let index = 0; index < lines.length; index += 1) {
      const text = lines[index];
      for (const criterion of Object.keys(GESTURE_SIGNALS) as GestureCriterion[]) {
        if (!GESTURE_SIGNALS[criterion].test(text)) continue;
        hits.push({ criterion, line: index + 1, text: truncate(text.trim(), 200) });
        criteriaSeen.add(criterion);
      }
    }

    if (hits.length === 0) continue;

    files.push({
      path: source.path,
      hits,
      excerpt: buildExcerpt(lines, hits),
      hasAlternativeSignal: ALTERNATIVE_SIGNAL.test(source.content),
    });
  }

  // Most hits first: a file with six drag handlers is more likely to be the
  // component that matters than one with a stray `pointerdown`.
  files.sort((a, b) => b.hits.length - a.hits.length);

  return {
    files: files.slice(0, MAX_CODE_FILES),
    filesScanned: scanned,
    criteriaSeen: [...criteriaSeen],
  };
}

function buildExcerpt(lines: readonly string[], hits: readonly GestureHit[]): string {
  const wanted = new Set<number>();
  for (const hit of hits) {
    const from = Math.max(1, hit.line - EXCERPT_RADIUS);
    const to = Math.min(lines.length, hit.line + EXCERPT_RADIUS);
    for (let line = from; line <= to; line += 1) wanted.add(line);
  }

  const ordered = [...wanted].sort((a, b) => a - b);
  const out: string[] = [];
  let previous = 0;

  for (const line of ordered) {
    if (previous !== 0 && line > previous + 1) out.push('   …');
    out.push(`${String(line).padStart(5, ' ')}| ${truncate(lines[line - 1] ?? '', 200)}`);
    previous = line;
  }

  return truncate(out.join('\n'), 12_000);
}

/* ========================================================================== */
/* Input and output                                                           */
/* ========================================================================== */

export interface CodeRepoRef {
  /** `owner/name`. */
  readonly fullName: string;
  /** The signed-in user's own GitHub token (A1.4). */
  readonly accessToken: string;
  /** Branch, tag or sha. Defaults to the repository's default branch. */
  readonly ref?: string;
}

export interface CodePageCapture {
  readonly url?: string;
  readonly finalUrl?: string;
  readonly title?: string | null;
}

export interface CodeLaneInput extends LaneCapabilityOptions {
  readonly pageUrl: string;
  readonly capture: CodePageCapture;
  readonly runId?: string;
  readonly phase?: AuditPhase;
  readonly pageId?: string | null;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /** Source the caller already holds. Takes precedence over `repo`. */
  readonly sources?: readonly SourceFile[];
  /** Read the repository through the user's own token. */
  readonly repo?: CodeRepoRef;
  /** Cap on files fetched from the repository before scanning. */
  readonly maxFiles?: number;
}

export interface CodeLaneResult extends ModelLaneResult {
  readonly filesScanned: number;
  readonly filesWithSignals: number;
  readonly scan: GestureScan | null;
}

const NO_SOURCE_REASON =
  'Gesture, motion and drag handlers exist only in source, and no repository source was available to this lane on this run. Nothing was read, so nothing can be concluded — least of all that these handlers are absent.';

const NO_SIGNAL_REASON =
  'No gesture, motion or drag handler matched the source scan. The scan is a line-level search over the application source it was given; a handler behind an aliased import, a compiled dependency, or a file the scan did not receive would not appear.';

/* ========================================================================== */
/* The lane                                                                   */
/* ========================================================================== */

/**
 * Read the source behind one page for the three handler-only criteria.
 *
 * Never throws. A repository that cannot be read leaves all three criteria
 * inconclusive with the GitHub error attached.
 */
export async function runCodeLane(input: CodeLaneInput): Promise<CodeLaneResult> {
  const empty = (reason: string, over: Partial<CodeLaneResult> = {}): CodeLaneResult => ({
    ...inconclusiveResult(CODE_POLICY.criteria, reason),
    filesScanned: 0,
    filesWithSignals: 0,
    scan: null,
    ...over,
  });

  if (input.signal?.aborted) {
    return empty('The run was cancelled before CODE read any source.');
  }

  let sources: readonly SourceFile[];
  if (input.sources && input.sources.length > 0) {
    sources = input.sources;
  } else if (input.repo) {
    try {
      sources = await readRepositorySource(input.repo, input.maxFiles ?? 400, input.signal);
    } catch (error) {
      return empty(
        `The repository source could not be read: ${describeError(error)}`,
        { warnings: [`CODE could not read ${input.repo.fullName}: ${describeError(error)}`] },
      );
    }
  } else {
    return empty(NO_SOURCE_REASON);
  }

  const scan = findGestureSignals(sources);

  if (scan.files.length === 0) {
    return empty(NO_SIGNAL_REASON, { filesScanned: scan.filesScanned, scan });
  }

  const capabilities = await resolveLaneCapabilities(input, input.signal);
  const answer = await runFindingsAgent({
    agent: 'code',
    criteria: CODE_POLICY.criteria,
    verdicts: CODE_POLICY.verdicts,
    prompt: buildCodePrompt(input, scan),
    timeoutMs: input.timeoutMs,
    signal: input.signal,
    ...capabilities,
  });

  if (answer.error !== null) {
    return empty(`The CODE pass did not return a usable answer: ${answer.error}`, {
      sessionId: answer.sessionId,
      warnings: [`CODE: ${answer.error}`],
      filesScanned: scan.filesScanned,
      scan,
    });
  }

  const findings = toClaims(CODE_POLICY, answer.findings, {
    pageUrl: input.pageUrl,
    pageId: input.pageId ?? null,
    source: 'code:source-scan',
    context: {
      model: answer.model,
      sessionId: answer.sessionId,
      filesScanned: scan.filesScanned,
    },
  });

  const warnings: string[] = [];
  if (answer.usedFallback) {
    warnings.push(`CODE answered on the fallback model ${answer.model} (A3.7).`);
  }

  /*
   * A criterion is evaluated only where the scan actually put a handler in
   * front of the model. If nothing in the source matched `2.5.4`, the model was
   * shown no motion listener, and its silence about motion actuation is not
   * evidence that there is none.
   */
  const evaluated = CODE_POLICY.criteria.filter((criterion) =>
    (scan.criteriaSeen as readonly string[]).includes(criterion),
  );
  const inconclusive: LaneInconclusive[] = CODE_POLICY.criteria
    .filter((criterion) => !evaluated.includes(criterion))
    .map((criterion) => ({ criterion, reason: NO_SIGNAL_REASON }));

  return {
    findings,
    sessionId: answer.sessionId,
    evaluated,
    inconclusive,
    warnings,
    filesScanned: scan.filesScanned,
    filesWithSignals: scan.files.length,
    scan,
  };
}

/* ========================================================================== */
/* Repository source                                                          */
/* ========================================================================== */

/**
 * List the repository, keep the files worth scanning, read them.
 *
 * Imported lazily so `@/lib/audit` does not pull Octokit into the module graph
 * for the four lanes that never touch a repository.
 */
async function readRepositorySource(
  repo: CodeRepoRef,
  maxFiles: number,
  signal?: AbortSignal,
): Promise<readonly SourceFile[]> {
  const { createGitHubClient, parseRepoRef } = await import('@/lib/github/client');
  const client = createGitHubClient(repo.accessToken);
  const { owner, repo: name } = parseRepoRef(repo.fullName);

  const ref = repo.ref ?? (await client.getDefaultBranch(repo.fullName));
  const { data } = await client.rest.rest.git.getTree({
    owner,
    repo: name,
    tree_sha: ref,
    recursive: '1',
  });

  const paths = (data.tree ?? [])
    .filter((entry) => entry.type === 'blob' && typeof entry.path === 'string')
    .map((entry) => entry.path as string)
    .filter(isScannableSource)
    .slice(0, Math.max(1, maxFiles));

  if (signal?.aborted) return [];

  const contents = await client.getFiles(repo.fullName, paths, ref);
  const sources: SourceFile[] = [];
  for (const [path, file] of contents) {
    if (file) sources.push({ path, content: file.contents });
  }
  return sources;
}

/* ========================================================================== */
/* Prompt                                                                     */
/* ========================================================================== */

function buildCodePrompt(input: CodeLaneInput, scan: GestureScan): string {
  const lines: string[] = [
    `PAGE UNDER AUDIT: ${input.pageUrl}`,
    ...(input.repo ? [`REPOSITORY: ${input.repo.fullName}${input.repo.ref ? `@${input.repo.ref}` : ''}`] : []),
    '',
    `A line-level scan of ${scan.filesScanned} source file(s) found gesture, motion or drag signals in ${scan.files.length} of them. The excerpts below are those files, numbered by real line number so you can cite them.`,
    '',
    'The scan finds candidates. It does not find violations, and you must not treat a match as one: the presence of a gesture handler is not a failure. The absence of a single-pointer alternative is. Look for the alternative in the excerpt before you report, and say in `detail` where you looked.',
    '',
  ];

  for (const file of scan.files) {
    const criteria = [...new Set(file.hits.map((hit) => hit.criterion))].join(', ');
    lines.push(
      `=== ${file.path} ===`,
      `matched: ${criteria} (${file.hits.length} line(s))` +
        (file.hasAlternativeSignal
          ? ' — this file also contains keyboard, button or click handling; check whether it is the alternative for this control'
          : ' — nothing in this file looks like a keyboard or button alternative'),
      file.excerpt,
      '',
    );
  }

  lines.push(
    `CRITERIA YOU OWN (${CODE_POLICY.criteria.length})`,
    renderCriterionTable(CODE_POLICY.criteria),
    '',
    'WHAT TO REPORT',
    '- `sourcePath` is the repository-relative path with a line number, exactly as shown above: `components/Carousel.tsx:48`. Never guess one, and never cite a file that is not in this prompt.',
    '- One finding per control per criterion. A component with a swipe handler and a drag handler and no alternative for either is two findings.',
    '- `verdict` is "FLAG" on every finding. Whether an alternative is genuinely equivalent is a human call and the response schema accepts no other value.',
    '- If a file matched the scan but plainly has an equivalent single-pointer path — arrow-key handlers on the same component, a pair of previous/next buttons, a click fallback — report nothing for it and let the silence mean what it means.',
    '- Excerpts are windows, not whole files. If you cannot see enough to judge, say that in `detail` rather than assuming the worst.',
  );

  return truncate(lines.join('\n'), 90_000);
}
