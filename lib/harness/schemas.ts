/**
 * Structured output contracts for the agent roster (requirement A13.5).
 *
 * Agents never write to the database (A13.6). They return JSON, the
 * application validates it here, and only then does anything reach the
 * findings ledger. Every schema is exported twice:
 *
 *   - as a zod schema, for validating what actually came back;
 *   - as a JSON Schema, for `response_format` on the agent manifest, so the
 *     provider constrains the model up front instead of us repairing prose.
 *
 * The findings schema is built per agent from the criteria that agent owns
 * and the verdicts that agent's lane is allowed to reach. A VIS agent
 * physically cannot emit a `2.5.4` finding: the enum does not contain it. A
 * MEDIA agent physically cannot emit a `DECIDE`: that enum does not contain
 * it either. That is policy enforced by the harness, not by a sentence in a
 * prompt.
 */

import { z } from "zod";

import type { ResponseFormat } from "./client";
import {
  WCAG_CRITERIA_BY_ID,
  WCAG_CRITERION_IDS,
  WCAG_CRITERION_PATTERN,
  isWcagCriterionId,
} from "./criteria";

/** A JSON Schema document, kept loose because providers extend it. */
export type JsonSchema = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

export const VERDICTS = ["DECIDE", "FLAG", "BLOCKED"] as const;
export const SEVERITIES = ["critical", "serious", "moderate", "minor"] as const;

export const VerdictSchema = z.enum(VERDICTS);
export const SeveritySchema = z.enum(SEVERITIES);

export type FindingVerdict = z.infer<typeof VerdictSchema>;
export type FindingSeverity = z.infer<typeof SeveritySchema>;

const CRITERION_MEMBERSHIP_MESSAGE =
  "criterion must be one of the 55 WCAG 2.2 Level A/AA success criteria";

/**
 * A criterion number that is both well-shaped and one of the 55 the harness
 * actually supports. `1.9.9` has the right shape and is still not a criterion;
 * accepting it leaves FIX and VERIFY output detached from the findings ledger.
 */
const CriterionIdSchema = z
  .string()
  .regex(WCAG_CRITERION_PATTERN, "criterion must look like `4.1.2`")
  .refine(isWcagCriterionId, { message: CRITERION_MEMBERSHIP_MESSAGE });

// ---------------------------------------------------------------------------
// Verdict policy
// ---------------------------------------------------------------------------

/**
 * The verdicts one lane may emit. Two rules live here rather than in a prompt,
 * because a prompt is advice and a schema is a guarantee:
 *
 *   - MEDIA and CODE are opinion lanes. Whether a transcript conveys the same
 *     information, and whether a gesture alternative is genuinely equivalent,
 *     are human calls; their output goes to the review queue and never to FIX.
 *     FLAG is the only verdict they may produce. MEDIA owns 1.2.2, whose
 *     registry class is DECIDE — the lane policy overrides the criterion.
 *   - A criterion this harness classes as BLOCKED is out of reach by
 *     definition, so DECIDE is never available for it, whatever the lane
 *     otherwise allows.
 */
export const ALL_VERDICTS: readonly FindingVerdict[] = VERDICTS;

/** The policy for the opinion lanes: every finding is a FLAG, always. */
export const FLAG_ONLY: readonly FindingVerdict[] = ["FLAG"];

/** The verdicts a given criterion may carry inside a lane allowing `laneVerdicts`. */
export function allowedVerdicts(
  criterionId: string,
  laneVerdicts: readonly FindingVerdict[] = ALL_VERDICTS,
): readonly FindingVerdict[] {
  const isBlocked = WCAG_CRITERIA_BY_ID.get(criterionId)?.verdict === "BLOCKED";
  return isBlocked ? laneVerdicts.filter((verdict) => verdict !== "DECIDE") : laneVerdicts;
}

/**
 * The single verdict enum a flat JSON Schema can publish for a lane: the union
 * of what each criterion in that lane allows. When one criterion is narrower
 * than the union — a BLOCKED-class criterion sitting in a lane that may
 * otherwise DECIDE — the flat enum cannot express it, so `verdictDescription`
 * states it in words and the zod schema enforces it for real.
 */
function laneVerdictEnum(
  criterionIds: readonly string[],
  laneVerdicts: readonly FindingVerdict[],
): FindingVerdict[] {
  const union = new Set<FindingVerdict>();
  for (const id of criterionIds) {
    for (const verdict of allowedVerdicts(id, laneVerdicts)) union.add(verdict);
  }
  // A lane with no criteria still needs a legal enum.
  if (union.size === 0) for (const verdict of laneVerdicts) union.add(verdict);
  return VERDICTS.filter((verdict) => union.has(verdict));
}

function verdictDescription(
  criterionIds: readonly string[],
  published: readonly FindingVerdict[],
): string {
  if (published.length === 1) {
    return `Always "${published[0]}" for this agent, and the only accepted value: this lane produces an opinion for a human to sign off, never a ruling.`;
  }
  let text =
    "DECIDE when you are ruling; FLAG when a human must sign off; BLOCKED when the check is out of reach.";
  const blocked = criterionIds.filter(
    (id) => WCAG_CRITERIA_BY_ID.get(id)?.verdict === "BLOCKED",
  );
  if (blocked.length > 0 && published.includes("DECIDE")) {
    text += ` DECIDE is never valid for ${blocked.join(", ")} — use BLOCKED and say in \`detail\` why the check was out of reach.`;
  }
  return text;
}

/**
 * One violation of one criterion on one page. `criterion` is never null and is
 * always one of the 55 — rule 3 of the non-negotiables.
 */
function findingObject(
  isAllowedCriterion: (id: string) => boolean,
  allowedMessage: string,
  laneVerdicts: readonly FindingVerdict[],
) {
  return z
    .object({
      criterion: z
        .string()
        .regex(WCAG_CRITERION_PATTERN, "criterion must look like `4.1.2`")
        .refine(isAllowedCriterion, { message: allowedMessage }),
      verdict: VerdictSchema,
      severity: SeveritySchema,
      /** One sentence. Goes straight into the ledger's `summary` column. */
      summary: z.string().min(1).max(400),
      /** The reasoning and the evidence that supports the claim. */
      detail: z.string().min(1),
      /** CSS selector for the offending element, when there is one. */
      selector: z.string().nullish(),
      /** Repository-relative source path, with a line number when known. */
      sourcePath: z.string().nullish(),
    })
    .superRefine((finding, ctx) => {
      const allowed = allowedVerdicts(finding.criterion, laneVerdicts);
      if (!allowed.includes(finding.verdict)) {
        ctx.addIssue({
          code: "custom",
          path: ["verdict"],
          message: `verdict for ${finding.criterion} must be one of ${allowed.join(", ")}, not ${finding.verdict}`,
        });
      }
    });
}

export const FindingSchema = findingObject(
  isWcagCriterionId,
  CRITERION_MEMBERSHIP_MESSAGE,
  ALL_VERDICTS,
);

export type Finding = z.infer<typeof FindingSchema>;

export const FindingsResponseSchema = z.object({
  findings: z.array(FindingSchema),
});

export type FindingsResponse = z.infer<typeof FindingsResponseSchema>;

/**
 * A findings schema narrowed to one agent's criteria and one agent's verdict
 * policy. Anything outside that agent's lane fails validation instead of
 * silently entering the ledger.
 */
export function buildFindingsSchema(
  criterionIds: readonly string[],
  laneVerdicts: readonly FindingVerdict[] = ALL_VERDICTS,
) {
  const allowed = new Set(criterionIds);
  return z.object({
    findings: z.array(
      findingObject(
        (id) => allowed.has(id),
        `criterion must be one this agent owns (${criterionIds.join(", ")})`,
        laneVerdicts,
      ),
    ),
  });
}

// ---------------------------------------------------------------------------
// Patches (FIX)
// ---------------------------------------------------------------------------

/**
 * FIX returns the **whole new file**, never a diff.
 *
 * It is worth saying why this changed, because the divergence cost a whole
 * run. `buildFixPrompt` in `lib/fix/patch.ts` has always asked for complete
 * file contents and `parseFixResponse` has always validated
 * `{ files: [...] }`. The saved FIX manifest asked for
 * `{ patches: [{ diff }] }`. A model constrained by the manifest answered in
 * the manifest's shape, zod stripped the unknown `patches` key, `files` fell
 * through to its `[]` default, and the run reported "FIX produced no patches"
 * with nothing to say about why. Two definitions of one contract was the bug.
 * There is now one.
 *
 * The shape matters on its own terms too. A model-authored diff has to be
 * right about line numbers and surrounding context before it can be right
 * about accessibility, and when it is wrong the run finds out in the sandbox.
 * Full contents always apply, and the host computes the diff from the exact
 * bytes it sent and the exact bytes it got back, so the stored diff cannot
 * describe a change that was not made.
 */
export const FilePatchSchema = z.object({
  /** Repository-relative path, exactly as it was given to the agent. */
  filePath: z.string().min(1),
  /** The complete file after the change. Every line, first to last. */
  newContents: z.string().min(1),
  /** Criterion numbers this change addresses. Never empty, always supported. */
  criteria: z.array(CriterionIdSchema).min(1),
  /** A5.5: ids of exactly the findings this change addresses. */
  findingIds: z.array(z.string()).default([]),
  /** Why this change is correct, in prose a reviewer can check. */
  rationale: z.string().min(1),
  /** Anything the change might plausibly break, for VERIFY to watch. */
  risk: z.string().nullish(),
});

export type FilePatch = z.infer<typeof FilePatchSchema>;

export const FilePatchSetResponseSchema = z.object({
  files: z.array(FilePatchSchema).default([]),
  /** Findings FIX declined to touch, each with a reason. */
  skipped: z
    .array(
      z.object({
        criterion: CriterionIdSchema.nullish(),
        findingIds: z.array(z.string()).default([]),
        reason: z.string().min(1),
      }),
    )
    .default([]),
});

export type FilePatchSetResponse = z.infer<typeof FilePatchSetResponseSchema>;

// ---------------------------------------------------------------------------
// Verification (VERIFY)
// ---------------------------------------------------------------------------

export const VerificationResponseSchema = z.object({
  buildPassed: z.boolean(),
  testsPassed: z.boolean(),
  /** The exact command that was run, e.g. `npm test`. */
  testCommand: z.string().min(1),
  /** Trimmed tail of the test output. The full log stays in the sandbox (A9.2). */
  testSummary: z.string().min(1),
  /** Per-criterion re-check result for every criterion a patch claimed (A6.3). */
  recheck: z.array(
    z.object({
      criterion: CriterionIdSchema,
      resolved: z.boolean(),
      note: z.string().min(1),
    }),
  ),
  /** VERIFY's gate on the pull request (A6.4). */
  recommendation: z.enum(["open-pull-request", "reject-patches"]),
});

export type VerificationResponse = z.infer<typeof VerificationResponseSchema>;

// ---------------------------------------------------------------------------
// JSON Schema forms, for `response_format`
// ---------------------------------------------------------------------------

/**
 * Optional string fields are emitted as `["string", "null"]` and kept in
 * `required`. That satisfies providers running in strict mode, which demand
 * every property be required, while the zod side accepts `null` or absent.
 */
const nullableString = { type: ["string", "null"] } as const;

/** The 55 canonical criterion numbers, for the schemas that are not lane-scoped. */
const CRITERION_ENUM: string[] = [...WCAG_CRITERION_IDS];

function findingsJsonSchema(
  criterionIds: readonly string[],
  laneVerdicts: readonly FindingVerdict[] = ALL_VERDICTS,
): JsonSchema {
  const verdicts = laneVerdictEnum(criterionIds, laneVerdicts);
  return {
    type: "object",
    additionalProperties: false,
    required: ["findings"],
    properties: {
      findings: {
        type: "array",
        description:
          "Every violation found. Empty when the page satisfies every criterion you own.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["criterion", "verdict", "severity", "summary", "detail", "selector", "sourcePath"],
          properties: {
            criterion: {
              type: "string",
              enum: [...criterionIds],
              description: "The WCAG 2.2 success criterion number this finding violates.",
            },
            verdict: {
              type: "string",
              enum: verdicts,
              description: verdictDescription(criterionIds, verdicts),
            },
            severity: {
              type: "string",
              enum: [...SEVERITIES],
              description: "Impact on a disabled user attempting the task.",
            },
            summary: {
              type: "string",
              description: "One sentence naming the element and the failure.",
            },
            detail: {
              type: "string",
              description:
                "The observation and the evidence behind it. State what you saw, not what is usually true.",
            },
            selector: {
              ...nullableString,
              description: "CSS selector for the offending element, or null.",
            },
            sourcePath: {
              ...nullableString,
              description: "Repository-relative source path with a line number, or null.",
            },
          },
        },
      },
    },
  };
}

/** The generic findings schema, across all 55 criteria. */
export const FINDINGS_JSON_SCHEMA: JsonSchema = findingsJsonSchema(WCAG_CRITERION_IDS);

/**
 * The provider-side constraint that matches `FilePatchSetResponseSchema`, and
 * therefore matches the prompt `buildFixPrompt` writes. These three move
 * together; nothing else in the codebase describes a FIX response.
 */
export const FILE_PATCH_SET_JSON_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["files", "skipped"],
  properties: {
    files: {
      type: "array",
      description: "One entry for the file you were given. Empty if you changed nothing.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["filePath", "newContents", "criteria", "findingIds", "rationale", "risk"],
        properties: {
          filePath: {
            type: "string",
            description: "Repository-relative path, exactly as it was given to you.",
          },
          newContents: {
            type: "string",
            description:
              "The complete file after your change. Every line, first to last, including the parts you did not touch. Never an excerpt, never a diff, never an ellipsis.",
          },
          criteria: {
            type: "array",
            minItems: 1,
            items: { type: "string", enum: CRITERION_ENUM },
            description:
              "Criterion numbers this change addresses, from the supported WCAG 2.2 A/AA set. Never empty.",
          },
          findingIds: {
            type: "array",
            items: { type: "string" },
            description: "Ids of exactly the findings this change addresses, from the list given.",
          },
          rationale: { type: "string", description: "Why this change is correct." },
          risk: { ...nullableString, description: "What it might break, or null." },
        },
      },
    },
    skipped: {
      type: "array",
      description: "Findings you deliberately did not fix, each with a real reason.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["criterion", "findingIds", "reason"],
        properties: {
          criterion: {
            ...nullableString,
            description: "The criterion of the finding that was skipped, or null.",
          },
          findingIds: { type: "array", items: { type: "string" } },
          reason: { type: "string" },
        },
      },
    },
  },
};

export const VERIFICATION_JSON_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "buildPassed",
    "testsPassed",
    "testCommand",
    "testSummary",
    "recheck",
    "recommendation",
  ],
  properties: {
    buildPassed: { type: "boolean" },
    testsPassed: { type: "boolean" },
    testCommand: { type: "string", description: "The exact command run, e.g. `npm test`." },
    testSummary: { type: "string", description: "Trimmed tail of the output. Full log stays in the sandbox." },
    recheck: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["criterion", "resolved", "note"],
        properties: {
          criterion: {
            type: "string",
            enum: CRITERION_ENUM,
            description: "A criterion one of the patches claimed to fix.",
          },
          resolved: { type: "boolean" },
          note: { type: "string" },
        },
      },
    },
    recommendation: { type: "string", enum: ["open-pull-request", "reject-patches"] },
  },
};

// ---------------------------------------------------------------------------
// `response_format` builders
// ---------------------------------------------------------------------------

function jsonSchemaResponseFormat(
  name: string,
  schema: JsonSchema,
  description: string,
): ResponseFormat {
  return {
    type: "json_schema",
    json_schema: { name, description, schema, strict: true },
  };
}

/**
 * `response_format` for an audit agent, narrowed to the criteria it owns and
 * the verdicts its lane is allowed to reach.
 */
export function buildFindingsResponseFormat(
  criterionIds: readonly string[],
  laneVerdicts: readonly FindingVerdict[] = ALL_VERDICTS,
): ResponseFormat {
  return jsonSchemaResponseFormat(
    "accessifix_findings",
    findingsJsonSchema(criterionIds, laneVerdicts),
    "Accessibility findings, one object per violated success criterion.",
  );
}

/**
 * `response_format` for FIX.
 *
 * The schema name changed with the shape on purpose: a saved manifest still
 * pinned to `accessifix_patch_set` is a stale one, and
 * `npm run agents:init -- --update` is what replaces it.
 */
export const FILE_PATCH_RESPONSE_FORMAT: ResponseFormat = jsonSchemaResponseFormat(
  "accessifix_file_patch",
  FILE_PATCH_SET_JSON_SCHEMA,
  "The complete new contents of each file changed, with the findings each change addresses.",
);

/** `response_format` for VERIFY. */
export const VERIFICATION_RESPONSE_FORMAT: ResponseFormat = jsonSchemaResponseFormat(
  "accessifix_verification",
  VERIFICATION_JSON_SCHEMA,
  "Build result, test-suite result, per-criterion re-check, and the pull-request gate.",
);
