/**
 * The MEDIA lane: four criteria, every one of them an opinion.
 *
 * Whether a transcript conveys the same information to someone who cannot hear,
 * and whether an audio description carries what the screen shows to someone who
 * cannot see, are human judgements. MEDIA gathers the evidence and states a
 * view; a person signs it off. Nothing this lane produces is ever sent to FIX
 * (A5.4).
 *
 * ---------------------------------------------------------------------------
 * FLAG, ALWAYS, AND NOT BECAUSE THE PROMPT SAYS SO
 *
 * Three locks, in order of how hard they are to talk around:
 *
 *   1. The saved `media` agent's `response_format` is
 *      `buildFindingsResponseFormat(MEDIA_CRITERIA, FLAG_ONLY)`. The verdict
 *      enum on the wire contains one string. The model cannot emit a DECIDE
 *      because there is nowhere to put it.
 *   2. `buildFindingsSchema` validates the reply against the same policy, so a
 *      provider that ignored the response format still fails here.
 *   3. `buildFinding` clamps the verdict to `allowedVerdicts`, which for this
 *      lane is `['FLAG']` on every criterion including 1.2.2 — whose registry
 *      class is DECIDE. The lane policy overrides the criterion, deliberately:
 *      comparing captions against speech is not something to be ruled on
 *      unheard.
 *
 * ---------------------------------------------------------------------------
 * NO MEDIA IS NOT A PASS
 *
 * A page with no `<video>` and no `<audio>` gets no findings — the criteria are
 * inapplicable and inventing a "no media found" finding would put noise in the
 * ledger. It does not get a pass either. The inventory below is built from the
 * accessibility tree and the page's links, and neither is a complete record of
 * embedded media: a player mounted after load, one inside a cross-origin frame,
 * or one exposed as a bare `generic` node will not appear. Saying "1.2.2 passes"
 * on the strength of not having noticed a video is exactly the false pass this
 * product exists to avoid, so the criteria come back inconclusive with that
 * stated.
 */

import { renderCriterionTable } from '@/lib/harness/criteria';

import { resolveLaneCapabilities, type LaneCapabilityOptions } from './lane-context';
import {
  collapse,
  inconclusiveResult,
  lanePolicy,
  runFindingsAgent,
  toClaims,
  truncate,
  type LaneInconclusive,
  type ModelLaneResult,
} from './model-lane';
import type { AxTreeLike } from './tree';
import type { AuditPhase } from './types';

/* ========================================================================== */
/* Lane policy                                                                */
/* ========================================================================== */

/** The four, from the roster, checked against `criteriaForAgent('MEDIA')`. */
export const MEDIA_POLICY = lanePolicy('media', 'MEDIA');

/* -- Build-time proof this lane really is FLAG-only ------------------------ */
{
  const wrong = MEDIA_POLICY.verdicts.filter((verdict) => verdict !== 'FLAG');
  if (wrong.length > 0 || MEDIA_POLICY.verdicts.length !== 1) {
    throw new Error(
      `MEDIA must be FLAG-only; the roster allows ${MEDIA_POLICY.verdicts.join(', ')}`,
    );
  }
}

/* ========================================================================== */
/* Media detection                                                            */
/* ========================================================================== */

/** Accessibility-tree roles Chrome uses for media elements and their players. */
const MEDIA_ROLES: readonly string[] = ['video', 'audio', 'Video', 'Audio'];

/** Roles that are only media when their name says so. */
const MAYBE_MEDIA_ROLES: readonly string[] = [
  'application',
  'Iframe',
  'iframe',
  'region',
  'group',
  'figure',
];

const MEDIA_NAME_PATTERN =
  /\b(video|audio|podcast|webinar|player|youtube|vimeo|wistia|loom|soundcloud|spotify|episode|recording|watch|listen|trailer|screencast|walkthrough)\b/i;

const MEDIA_FILE_PATTERN = /\.(mp4|webm|ogg|ogv|mov|m4v|avi|mkv|mp3|wav|m4a|aac|flac|m3u8)(\?|#|$)/i;

const MEDIA_HOST_PATTERN =
  /(youtube\.com|youtu\.be|vimeo\.com|wistia\.(com|net)|loom\.com|soundcloud\.com|spotify\.com|dailymotion\.com|brightcove\.(net|com)|jwplayer\.com|anchor\.fm|libsyn\.com)/i;

/** Roles that, when present, say something about the alternatives on offer. */
const ALTERNATIVE_NAME_PATTERN =
  /\b(transcript|caption|subtitle|closed captions?|cc|audio description|described|sign language)\b/i;

export interface MediaItem {
  /** `tree` when the accessibility tree exposed it, `link` when a URL implied it. */
  readonly via: 'tree' | 'link';
  readonly kind: 'video' | 'audio' | 'unknown';
  readonly role?: string | null;
  /** Accessible name, or the link text, or the URL. */
  readonly label: string;
  readonly url?: string;
}

export interface MediaInventory {
  readonly items: readonly MediaItem[];
  /** Nodes and links that look like a transcript, caption or description offer. */
  readonly alternatives: readonly string[];
}

/**
 * Everything on this page that looks like audio or video.
 *
 * Deliberately generous on the tree side and narrow on the link side: a role of
 * `video` is conclusive, a link ending `.mp4` is conclusive, and a `group`
 * called "Watch the walkthrough" is worth showing the model even though it may
 * turn out to be a still image with a caption. The model is told which is which.
 */
export function collectMedia(
  tree: AxTreeLike | null | undefined,
  links: readonly string[] = [],
): MediaInventory {
  const items: MediaItem[] = [];
  const alternatives: string[] = [];
  const seen = new Set<string>();

  const push = (item: MediaItem): void => {
    const key = `${item.via}|${item.kind}|${item.url ?? item.label}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push(item);
  };

  for (const node of Object.values(tree ?? {})) {
    const role = (node.role ?? '').trim();
    const name = collapse(node.name ?? '');
    if (role.length === 0 && name.length === 0) continue;

    if (ALTERNATIVE_NAME_PATTERN.test(name) && name.length > 0) {
      if (alternatives.length < 40) alternatives.push(`${role || 'node'}: ${truncate(name, 120)}`);
    }

    const lowered = role.toLowerCase();
    if (MEDIA_ROLES.some((media) => media.toLowerCase() === lowered)) {
      push({
        via: 'tree',
        kind: lowered === 'audio' ? 'audio' : 'video',
        role,
        label: name.length > 0 ? truncate(name, 160) : '<no accessible name>',
      });
      continue;
    }

    if (MAYBE_MEDIA_ROLES.includes(role) && MEDIA_NAME_PATTERN.test(name)) {
      push({ via: 'tree', kind: 'unknown', role, label: truncate(name, 160) });
    }
  }

  for (const link of links) {
    if (MEDIA_FILE_PATTERN.test(link)) {
      push({
        via: 'link',
        kind: /\.(mp3|wav|m4a|aac|flac)(\?|#|$)/i.test(link) ? 'audio' : 'video',
        label: truncate(link, 200),
        url: link,
      });
      continue;
    }
    if (MEDIA_HOST_PATTERN.test(link)) {
      push({ via: 'link', kind: 'unknown', label: truncate(link, 200), url: link });
    }
  }

  return { items, alternatives };
}

/* ========================================================================== */
/* Input and output                                                           */
/* ========================================================================== */

export interface MediaPageCapture {
  readonly url?: string;
  readonly finalUrl?: string;
  readonly title?: string | null;
  readonly axTree?: AxTreeLike;
  readonly links?: readonly string[];
}

export interface MediaLaneInput extends LaneCapabilityOptions {
  readonly pageUrl: string;
  readonly capture: MediaPageCapture;
  readonly runId?: string;
  readonly phase?: AuditPhase;
  readonly pageId?: string | null;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /**
   * Captions, transcripts and descriptions the caller has already fetched.
   *
   * The crawl does not download media, so this is normally empty and the lane
   * says so in the prompt. When it is supplied — a caption track pulled by a
   * later pass — the model compares rather than speculates, and its findings
   * get much sharper.
   */
  readonly alternatives?: readonly { readonly label: string; readonly text: string }[];
}

export interface MediaLaneResult extends ModelLaneResult {
  readonly mediaFound: number;
  readonly inventory: MediaInventory;
}

const NO_MEDIA_REASON =
  'No audio or video was detected on this page. The inventory is built from the accessibility tree and the page links, neither of which is a complete record of embedded media, so this is "nothing was found", not "there is nothing".';

const NO_ASSET_REASON =
  'MEDIA can see that a player is present but cannot fetch the media or its caption track, so equivalence was judged from the page alone and a human must confirm it.';

/* ========================================================================== */
/* The lane                                                                   */
/* ========================================================================== */

/**
 * Audit one page's media. Every finding is a FLAG; there are no exceptions and
 * there is no code path that produces anything else.
 *
 * Never throws. This lane runs in its own queue and must never block or fail a
 * browser lane (A3.4).
 */
export async function runMediaLane(input: MediaLaneInput): Promise<MediaLaneResult> {
  const inventory = collectMedia(input.capture.axTree, input.capture.links ?? []);

  if (input.signal?.aborted) {
    return {
      ...inconclusiveResult(
        MEDIA_POLICY.criteria,
        'The run was cancelled before MEDIA looked at this page.',
      ),
      mediaFound: inventory.items.length,
      inventory,
    };
  }

  if (inventory.items.length === 0) {
    // No findings, and no pass either. The criteria are inapplicable as far as
    // this lane could see, and "as far as this lane could see" is the load-
    // bearing half of that sentence.
    return {
      ...inconclusiveResult(MEDIA_POLICY.criteria, NO_MEDIA_REASON),
      mediaFound: 0,
      inventory,
    };
  }

  const capabilities = await resolveLaneCapabilities(input, input.signal);
  const answer = await runFindingsAgent({
    agent: 'media',
    criteria: MEDIA_POLICY.criteria,
    verdicts: MEDIA_POLICY.verdicts,
    prompt: buildMediaPrompt(input, inventory),
    timeoutMs: input.timeoutMs,
    signal: input.signal,
    ...capabilities,
  });

  if (answer.error !== null) {
    return {
      ...inconclusiveResult(
        MEDIA_POLICY.criteria,
        `The MEDIA pass did not return a usable answer: ${answer.error}`,
      ),
      sessionId: answer.sessionId,
      warnings: [`MEDIA: ${answer.error}`],
      mediaFound: inventory.items.length,
      inventory,
    };
  }

  const findings = toClaims(MEDIA_POLICY, answer.findings, {
    pageUrl: input.pageUrl,
    pageId: input.pageId ?? null,
    source: 'media:inventory',
    context: {
      model: answer.model,
      sessionId: answer.sessionId,
      mediaFound: inventory.items.length,
    },
  });

  const warnings: string[] = [];
  if (answer.usedFallback) {
    warnings.push(`MEDIA answered on the fallback model ${answer.model} (A3.7).`);
  }

  /*
   * Every criterion stays inconclusive even on a successful pass, and that is
   * not a hedge. MEDIA's whole output is FLAG: a human signs off on each
   * finding, and the criteria it did not file against were judged from a
   * player's presence rather than from the media itself. Marking them evaluated
   * would let a scorer print a pass for captions nobody listened to.
   */
  const inconclusive: LaneInconclusive[] = MEDIA_POLICY.criteria.map((criterion) => ({
    criterion,
    reason: NO_ASSET_REASON,
  }));

  return {
    findings,
    sessionId: answer.sessionId,
    evaluated: [],
    inconclusive,
    warnings,
    mediaFound: inventory.items.length,
    inventory,
  };
}

/* ========================================================================== */
/* Prompt                                                                     */
/* ========================================================================== */

function buildMediaPrompt(input: MediaLaneInput, inventory: MediaInventory): string {
  const supplied = input.alternatives ?? [];

  const lines: string[] = [
    `PAGE: ${input.pageUrl}`,
    ...(input.capture.title ? [`TITLE: ${input.capture.title}`] : []),
    '',
    `MEDIA FOUND ON THIS PAGE (${inventory.items.length})`,
    ...inventory.items.map(
      (item, index) =>
        `[${index + 1}] ${item.kind} via ${item.via}` +
        (item.role ? ` role=${item.role}` : '') +
        ` — ${item.label}` +
        (item.url ? ` (${item.url})` : ''),
    ),
    '',
    'Entries marked `via tree` came from the accessibility tree; a `kind` of `unknown` means the node only looked like media by its name and may not be. Entries marked `via link` are URLs on the page that point at a media file or a known media host.',
  ];

  if (inventory.alternatives.length > 0) {
    lines.push(
      '',
      'ALTERNATIVES THE PAGE APPEARS TO OFFER',
      ...inventory.alternatives.map((alternative) => `- ${alternative}`),
      'These are accessible names that mention a transcript, captions or a description. Their presence is not proof that the alternative exists or is equivalent.',
    );
  } else {
    lines.push(
      '',
      'ALTERNATIVES THE PAGE APPEARS TO OFFER',
      '- None. Nothing in the accessibility tree names a transcript, captions, subtitles or an audio description.',
    );
  }

  if (supplied.length > 0) {
    lines.push('', 'CAPTION AND TRANSCRIPT TEXT SUPPLIED WITH THIS PAGE');
    for (const alternative of supplied) {
      lines.push(`--- ${alternative.label} ---`, truncate(alternative.text, 8_000));
    }
  } else {
    lines.push(
      '',
      'CAPTION AND TRANSCRIPT TEXT SUPPLIED WITH THIS PAGE',
      '- None. The crawl does not download media, so you cannot compare a caption against speech on this run. Say so plainly in `detail` rather than describing a comparison you did not make: "no caption track was retrievable, so equivalence is unverified" is a useful finding; an invented timestamp is not.',
    );
  }

  lines.push(
    '',
    `CRITERIA YOU OWN (${MEDIA_POLICY.criteria.length})`,
    renderCriterionTable(MEDIA_POLICY.criteria),
    '',
    'WHAT TO REPORT',
    '- One finding per criterion per media item. Four criteria and two videos is at most eight findings, not one generic complaint.',
    '- `verdict` is "FLAG" on every finding, on every criterion, however certain you are. The response schema accepts nothing else.',
    '- Quote what you were actually given. If all you have is a player with no named transcript, the finding is that no alternative is offered — say which item, by its number above.',
    '- An entry whose `kind` is `unknown` may not be media at all. Say that you are unsure rather than filing a confident finding against a still image.',
    '- If an item plainly does have an equivalent alternative named on the page, report nothing for it.',
  );

  return truncate(lines.join('\n'), 60_000);
}
