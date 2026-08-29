/**
 * lib/vision - public surface.
 *
 * The second source for path enumeration (A4.1, A4.2).
 *
 * `lib/paths` reads the accessibility tree and subtracts it from what a sighted
 * user can see. It cannot produce the second list itself - that needs an eye on
 * a screenshot - so it takes one as an optional input and degrades to tree-only
 * without it. This module produces it.
 *
 *   schemas.ts     the structured-output contract: a closed appearance
 *                  vocabulary, and a `labelSource` field that makes the model
 *                  declare when a label is its own name for an icon rather than
 *                  words it read off the page.
 *   candidates.ts  the call. One screenshot, one turn, one validated list,
 *                  damped by how the model came by each label.
 *
 * Nothing here decides anything. It observes; `diffSources` in `lib/paths`
 * compares, classifies and scores; `recordFindings` in `lib/pipeline` persists.
 * The model is never shown the accessibility tree and is never asked whether
 * something is a violation.
 */

export {
  extractVisionCandidates,
  shape,
  VisionPassError,
  VISION_CANDIDATE_INSTRUCTIONS,
  LABEL_SOURCE_DAMPING,
  MAX_SCREENSHOT_BYTES,
  MAX_VISION_CANDIDATES,
  MIN_STATED_CONFIDENCE,
  VISION_ATTEMPTS,
  VISION_TIMEOUT_MS,
  type ExtractVisionCandidatesInput,
  type VisionCandidatesResult,
  type VisionSkipReason,
} from "./candidates";

export {
  buildVisionCandidatesResponseFormat,
  buildVisionCandidatesSchema,
  VisionCandidateSchema,
  VisionCandidatesResponseSchema,
  VISION_CANDIDATES_JSON_SCHEMA,
  VISION_CANDIDATES_RESPONSE_FORMAT,
  VISION_LABEL_SOURCES,
  VISION_LOOKS_LIKE,
  type VisionCandidate,
  type VisionCandidatesResponse,
  type VisionLabelSource,
  type VisionLooksLike,
} from "./schemas";
