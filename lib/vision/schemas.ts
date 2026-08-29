/**
 * Structured output contract for the VIS candidate-extraction pass (A4.2).
 *
 * This is not the findings contract. `lib/harness/schemas.ts` narrows a
 * findings schema per agent so a lane physically cannot emit a criterion it
 * does not own; the same idea is applied here to a different question.
 *
 * The question is deliberately narrow: *what in this screenshot looks like
 * something you could click?* Not "what is broken", not "what role should this
 * have" - the model is being used as an eye, and every extra inference it is
 * invited to make is a false positive waiting to reach the ledger.
 *
 * Two fields exist purely to keep the model honest about that:
 *
 *   `looksLike`    a closed enum. The model names the shape it sees. It cannot
 *                  invent `aria-haspopup="dialog"`, because the enum has no
 *                  such member, and `lib/paths` maps the word back onto a role
 *                  itself (`roleFromLooksLike`).
 *   `labelSource`  where the words came from. An icon with no text is the top
 *                  false-positive risk in the whole feature: a model that sees
 *                  a hamburger and writes "Menu" has *inferred* a label, and a
 *                  label that appears nowhere in the accessibility tree is
 *                  exactly what a vision-only finding is built on. Making the
 *                  model state it turns that risk into a scored term rather
 *                  than a surprise.
 *
 * Both are exported as zod (to validate what came back) and as JSON Schema (for
 * `response_format`, so the provider constrains the model up front instead of
 * us repairing prose afterwards) - the same double form the findings schemas
 * use.
 */

import { z } from "zod";

import type { ResponseFormat } from "@/lib/harness/client";
import type { JsonSchema } from "@/lib/harness/schemas";

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The shapes a control can take on screen, as a closed set.
 *
 * These are *appearances*, not ARIA roles. `clickable-card` and
 * `modal-trigger` have no ARIA equivalent at all, and that is the point: the
 * model reports what it can see, and `roleFromLooksLike` in `lib/paths`
 * decides what, if anything, that implies about semantics.
 */
export const VISION_LOOKS_LIKE = [
  "button",
  "link",
  "dropdown",
  "tab",
  "toggle",
  "checkbox",
  "radio",
  "menu-item",
  "modal-trigger",
  "clickable-card",
  "text-field",
  "slider",
  "other",
] as const;

export type VisionLooksLike = (typeof VISION_LOOKS_LIKE)[number];

/**
 * Where the label text came from.
 *
 * `visible-text`            the words are rendered on the control and can be
 *                           read straight off it.
 * `icon-only`               there is no text; the label is the model's own
 *                           name for a glyph.
 * `tooltip-or-placeholder`  the words are on screen but are not the control's
 *                           own rendered label - a placeholder, a tooltip,
 *                           adjacent text.
 *
 * Only `visible-text` supports a confident claim that the accessibility tree
 * is missing this exact string. The other two are damped in `candidates.ts`
 * before the label ever reaches the diff.
 */
export const VISION_LABEL_SOURCES = [
  "visible-text",
  "icon-only",
  "tooltip-or-placeholder",
] as const;

export type VisionLabelSource = (typeof VISION_LABEL_SOURCES)[number];

/* -------------------------------------------------------------------------- */
/* zod                                                                        */
/* -------------------------------------------------------------------------- */

/** One thing in the screenshot that looks like it can be operated. */
export const VisionCandidateSchema = z.object({
  /**
   * The words on the control, verbatim. Not a description of it: the diff
   * matches this string against accessible names in the tree, so
   * "Submit application" matches and "the green submit button" never will.
   */
  label: z.string().min(1).max(160),
  /**
   * The model's best guess at a selector. Never trusted - it is scored at
   * `SELECTOR_CONFIDENCE.visionApprox` and resolved against the real DOM only
   * when ACT drives the path.
   */
  approxSelector: z.string().max(400),
  looksLike: z.enum(VISION_LOOKS_LIKE),
  labelSource: z.enum(VISION_LABEL_SOURCES),
  /** The model's own certainty that this is operable, 0..1. */
  confidence: z.number().min(0).max(1),
});

export type VisionCandidate = z.infer<typeof VisionCandidateSchema>;

export const VisionCandidatesResponseSchema = z.object({
  candidates: z.array(VisionCandidateSchema),
});

export type VisionCandidatesResponse = z.infer<typeof VisionCandidatesResponseSchema>;

/**
 * A candidates schema narrowed to a subset of the appearance vocabulary.
 *
 * Mirrors `buildFindingsSchema`: the caller states what this pass is allowed to
 * report, and anything outside it fails validation rather than entering the
 * enumeration.
 */
export function buildVisionCandidatesSchema(
  looksLike: readonly VisionLooksLike[] = VISION_LOOKS_LIKE,
) {
  const allowed = new Set<string>(looksLike);
  return z.object({
    candidates: z.array(
      VisionCandidateSchema.refine((candidate) => allowed.has(candidate.looksLike), {
        message: `looksLike must be one this pass accepts (${looksLike.join(", ")})`,
        path: ["looksLike"],
      }),
    ),
  });
}

/* -------------------------------------------------------------------------- */
/* JSON Schema, for `response_format`                                         */
/* -------------------------------------------------------------------------- */

function candidatesJsonSchema(looksLike: readonly VisionLooksLike[]): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    required: ["candidates"],
    properties: {
      candidates: {
        type: "array",
        description:
          "Every element in the screenshot that looks like it can be clicked, tapped, typed into or dragged. Empty only if the page genuinely has no controls.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["label", "approxSelector", "looksLike", "labelSource", "confidence"],
          properties: {
            label: {
              type: "string",
              description:
                "The text on the control, transcribed exactly as rendered - same words, same order, same case. Not a description of the control. If it shows no text at all, name the glyph in one or two words and set labelSource to icon-only.",
            },
            approxSelector: {
              type: "string",
              description:
                "Your best guess at a CSS selector, e.g. `header nav button:nth-of-type(2)`. A rough structural guess is useful; an invented `#id` is not. Only use an id or class if you can actually read one on the page.",
            },
            looksLike: {
              type: "string",
              enum: [...looksLike],
              description:
                "The shape you can see, not the role you think it ought to have. Use `other` rather than forcing a fit.",
            },
            labelSource: {
              type: "string",
              enum: [...VISION_LABEL_SOURCES],
              description:
                "Where the words in `label` came from. `visible-text` when they are rendered on the control itself. `icon-only` when the control shows only a glyph and you named it yourself - say so rather than guessing a name and passing it off as text. `tooltip-or-placeholder` when the words are on screen but are not the control's own label.",
            },
            confidence: {
              type: "number",
              description:
                "0 to 1: how sure you are that clicking this would do something. Headings, body copy, static labels and decorative artwork are not controls - leave them out entirely rather than reporting them at low confidence.",
            },
          },
        },
      },
    },
  };
}

/** The candidates schema across the whole appearance vocabulary. */
export const VISION_CANDIDATES_JSON_SCHEMA: JsonSchema =
  candidatesJsonSchema(VISION_LOOKS_LIKE);

/* -------------------------------------------------------------------------- */
/* `response_format`                                                          */
/* -------------------------------------------------------------------------- */

/**
 * `response_format` for the candidate-extraction pass, narrowed to the
 * appearances the caller will accept.
 */
export function buildVisionCandidatesResponseFormat(
  looksLike: readonly VisionLooksLike[] = VISION_LOOKS_LIKE,
): ResponseFormat {
  return {
    type: "json_schema",
    json_schema: {
      name: "accessifix_vision_candidates",
      description:
        "Every element in a page screenshot that looks interactive, as seen rather than as inferred.",
      schema: candidatesJsonSchema(looksLike),
      strict: true,
    },
  };
}

export const VISION_CANDIDATES_RESPONSE_FORMAT: ResponseFormat =
  buildVisionCandidatesResponseFormat();
