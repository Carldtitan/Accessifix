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
 * The findings schema is built per agent from the criteria that agent owns.
 * A VIS agent physically cannot emit a `2.5.4` finding: the enum does not
 * contain it. That is criterion routing enforced by the harness, not by a
 * sentence in a prompt.
 */

import { z } from "zod";

import type { ResponseFormat } from "./client";
import { WCAG_CRITERION_IDS, WCAG_CRITERION_PATTERN, isWcagCriterionId } from "./criteria";

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

/**
 * One violation of one criterion on one page. `criterion` is never null and is
 * always one of the 55 — rule 3 of the non-negotiables.
 */
function findingObject(isAllowedCriterion: (id: string) => boolean, allowedMessage: string) {
  return z.object({
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
  });
}

export const FindingSchema = findingObject(
  isWcagCriterionId,
  "criterion must be one of the 55 WCAG 2.2 Level A/AA success criteria",
);

export type Finding = z.infer<typeof FindingSchema>;

export const FindingsResponseSchema = z.object({
  findings: z.array(FindingSchema),
});

export type FindingsResponse = z.infer<typeof FindingsResponseSchema>;

/**
 * A findings schema narrowed to one agent's criteria. Anything outside that
 * agent's lane fails validation instead of silently entering the ledger.
 */
export function buildFindingsSchema(criterionIds: readonly string[]) {
  const allowed = new Set(criterionIds);
  return z.object({
    findings: z.array(
      findingObject(
        (id) => allowed.has(id),
        `criterion must be one this agent owns (${criterionIds.join(", ")})`,
      ),
    ),
  });
}

// ---------------------------------------------------------------------------
// Patches (FIX)
// ---------------------------------------------------------------------------

/** One patch, batched per source file, recording which findings it covers (A5.2, A5.5). */
export const PatchSchema = z.object({
  sourcePath: z.string().min(1),
  /** Unified diff against the file as it stands in the target repository. */
  diff: z.string().min(1),
  /** Criterion numbers this patch addresses. Never empty. */
  criteria: z.array(z.string().regex(WCAG_CRITERION_PATTERN)).min(1),
  /** Why this change is correct, in prose a reviewer can check. */
  rationale: z.string().min(1),
  /** Anything the patch might plausibly break, for VERIFY to watch. */
  risk: z.string().nullish(),
});

export type Patch = z.infer<typeof PatchSchema>;

export const PatchSetResponseSchema = z.object({
  patches: z.array(PatchSchema),
  /** Findings FIX declined to touch, each with a reason. */
  skipped: z
    .array(
      z.object({
        criterion: z.string().regex(WCAG_CRITERION_PATTERN),
        reason: z.string().min(1),
      }),
    )
    .default([]),
});

export type PatchSetResponse = z.infer<typeof PatchSetResponseSchema>;

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
      criterion: z.string().regex(WCAG_CRITERION_PATTERN),
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

function findingsJsonSchema(criterionIds: readonly string[]): JsonSchema {
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
              enum: [...VERDICTS],
              description:
                "DECIDE when you are ruling; FLAG when a human must sign off; BLOCKED when the check is out of reach.",
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

export const PATCH_SET_JSON_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["patches", "skipped"],
  properties: {
    patches: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["sourcePath", "diff", "criteria", "rationale", "risk"],
        properties: {
          sourcePath: { type: "string", description: "Repository-relative path of the file patched." },
          diff: { type: "string", description: "Unified diff for this one file." },
          criteria: {
            type: "array",
            items: { type: "string" },
            description: "Criterion numbers this patch addresses. Never empty.",
          },
          rationale: { type: "string", description: "Why this change is correct." },
          risk: { ...nullableString, description: "What it might break, or null." },
        },
      },
    },
    skipped: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["criterion", "reason"],
        properties: {
          criterion: { type: "string" },
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
          criterion: { type: "string" },
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

/** `response_format` for an audit agent, narrowed to the criteria it owns. */
export function buildFindingsResponseFormat(criterionIds: readonly string[]): ResponseFormat {
  return jsonSchemaResponseFormat(
    "accessifix_findings",
    findingsJsonSchema(criterionIds),
    "Accessibility findings, one object per violated success criterion.",
  );
}

/** `response_format` for FIX. */
export const PATCH_SET_RESPONSE_FORMAT: ResponseFormat = jsonSchemaResponseFormat(
  "accessifix_patch_set",
  PATCH_SET_JSON_SCHEMA,
  "One unified diff per source file, with the findings each diff addresses.",
);

/** `response_format` for VERIFY. */
export const VERIFICATION_RESPONSE_FORMAT: ResponseFormat = jsonSchemaResponseFormat(
  "accessifix_verification",
  VERIFICATION_JSON_SCHEMA,
  "Build result, test-suite result, per-criterion re-check, and the pull-request gate.",
);
