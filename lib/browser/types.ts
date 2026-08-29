/**
 * Shared browser-layer types.
 *
 * Every type here is derived from a zod schema rather than declared alongside
 * one. The sandbox is a separate process producing JSON over stdout, so its
 * output is untrusted input: runner.ts parses it through these schemas and a
 * malformed response is rejected instead of flowing into the ledger.
 */

import { z } from 'zod';

/* ------------------------------------------------------------------ */
/* Accessibility tree                                                   */
/* ------------------------------------------------------------------ */

/**
 * The six state properties that matter for the state criteria.
 *
 * Values are kept as strings ('true', 'false', 'mixed') or null. Null means the
 * property is absent, which is the distinction the whole product turns on: on
 * clearway-kappa.vercel.app the "EnglishEN" control added 98 tree nodes on click
 * while `expanded` stayed null on both sides — a WCAG 4.1.2 failure.
 */
export const AX_STATE_PROPS = [
  'expanded',
  'checked',
  'selected',
  'pressed',
  'focused',
  'disabled',
] as const;

export type AxStateProp = (typeof AX_STATE_PROPS)[number];

export const axPropsSchema = z.object({
  expanded: z.string().nullable().default(null),
  checked: z.string().nullable().default(null),
  selected: z.string().nullable().default(null),
  pressed: z.string().nullable().default(null),
  focused: z.string().nullable().default(null),
  disabled: z.string().nullable().default(null),
});

export type AxProps = z.infer<typeof axPropsSchema>;

export const axNodeSchema = z.object({
  /** CDP AXNodeId. Unique within one getFullAXTree call. */
  nodeId: z.string(),
  /** `node.role?.value` from the CDP payload. */
  role: z.string().nullable().default(null),
  /** `node.name?.value` — the computed accessible name. */
  name: z.string().nullable().default(null),
  /** Nodes Chrome marks as ignored are kept, so "became ignored" stays visible. */
  ignored: z.boolean().default(false),
  backendDomNodeId: z.number().nullable().default(null),
  childIds: z.array(z.string()).default([]),
  props: axPropsSchema,
});

export type AxNode = z.infer<typeof axNodeSchema>;

/** The normalised tree: nodeId -> node. */
export const axTreeSchema = z.record(z.string(), axNodeSchema);

export type AxTree = z.infer<typeof axTreeSchema>;

/* ------------------------------------------------------------------ */
/* Interaction paths                                                    */
/* ------------------------------------------------------------------ */

export const interactionActionSchema = z.enum(['click', 'hover', 'focus', 'key']);
export type InteractionAction = z.infer<typeof interactionActionSchema>;

/**
 * The three path templates from A4.5.
 *
 * - toggle: snapshot, click, snapshot. Tree changed but state attribute did not
 *   is a 4.1.2 finding.
 * - dialog: open, assert focus moved inside, Escape, assert focus returned.
 * - form: submit empty, assert the error is in text, announced, and focused.
 */
export const pathTemplateSchema = z.enum(['toggle', 'dialog', 'form']);
export type PathTemplate = z.infer<typeof pathTemplateSchema>;

export const interactionPathSchema = z.object({
  /** Optional stable id so a result can be correlated back to a ledger row. */
  id: z.string().optional(),
  /** CSS selector for the control. Resolved with `page.locator(...).first()`. */
  selector: z.string().min(1),
  /** Human-readable label, used in findings and in the run view. */
  label: z.string().default(''),
  action: interactionActionSchema,
  /** Required when action is 'key'; defaults to Enter. */
  key: z.string().optional(),
  template: pathTemplateSchema,
});

export type InteractionPath = z.infer<typeof interactionPathSchema>;

/* ------------------------------------------------------------------ */
/* Element state                                                        */
/* ------------------------------------------------------------------ */

/**
 * The DOM-side view of the control, read before and after the action.
 *
 * The accessibility tree says what assistive technology perceives; this says
 * what the author actually wrote. A 4.1.2 finding needs both.
 */
export const elementStateSchema = z.object({
  present: z.boolean(),
  tagName: z.string().nullable().default(null),
  /** The explicit `role` attribute, not the computed role. */
  role: z.string().nullable().default(null),
  text: z.string().nullable().default(null),
  /** aria-expanded, aria-checked, aria-selected, aria-pressed, open, disabled, ... */
  attributes: z.record(z.string(), z.string().nullable()).default({}),
});

export type ElementState = z.infer<typeof elementStateSchema>;

/* ------------------------------------------------------------------ */
/* axe-core                                                             */
/* ------------------------------------------------------------------ */

export const axeNodeSchema = z.object({
  target: z.array(z.string()).default([]),
  html: z.string().default(''),
  failureSummary: z.string().nullable().default(null),
});

export type AxeNode = z.infer<typeof axeNodeSchema>;

export const axeViolationSchema = z.object({
  id: z.string(),
  impact: z.string().nullable().default(null),
  help: z.string().default(''),
  description: z.string().default(''),
  helpUrl: z.string().default(''),
  /** Includes the `wcag412`-style tags the criterion mapper reads. */
  tags: z.array(z.string()).default([]),
  nodes: z.array(axeNodeSchema).default([]),
});

export type AxeViolation = z.infer<typeof axeViolationSchema>;

/* ------------------------------------------------------------------ */
/* Results produced inside the sandbox                                  */
/* ------------------------------------------------------------------ */

export const screenshotRefSchema = z.object({
  /** Absolute path inside the sandbox. Downloaded as an artifact (A9.2). */
  path: z.string().nullable().default(null),
  bytes: z.number().default(0),
  /** Populated only when the job asked for it inline; usually null. */
  base64: z.string().nullable().default(null),
});

export type ScreenshotRef = z.infer<typeof screenshotRefSchema>;

export const pathResultSchema = z.object({
  path: interactionPathSchema,
  /** False when the selector missed or the action threw. Never fatal to the run. */
  ok: z.boolean(),
  error: z.string().nullable().default(null),
  treeBefore: axTreeSchema.default({}),
  treeAfter: axTreeSchema.default({}),
  stateBefore: elementStateSchema.nullable().default(null),
  stateAfter: elementStateSchema.nullable().default(null),
  /** Template-specific evidence: focus movement for dialogs, error text for forms. */
  observations: z.record(z.string(), z.unknown()).default({}),
  screenshot: screenshotRefSchema.nullable().default(null),
  durationMs: z.number().default(0),
});

export type PathResult = z.infer<typeof pathResultSchema>;

/**
 * The single JSON blob the sandbox script prints between its delimiters.
 * runner.ts never trusts a field that is not in this schema.
 */
export const browserResultSchema = z.object({
  ok: z.boolean(),
  error: z.string().nullable().default(null),
  requestedUrl: z.string().default(''),
  finalUrl: z.string().default(''),
  title: z.string().default(''),
  axTree: axTreeSchema.default({}),
  screenshot: screenshotRefSchema.nullable().default(null),
  axeViolations: z.array(axeViolationSchema).default([]),
  /** Same-origin links found on the page, for the crawler (A2.2). */
  links: z.array(z.string()).default([]),
  paths: z.array(pathResultSchema).default([]),
  /** Rough stage timings, in milliseconds. */
  timings: z.record(z.string(), z.number()).default({}),
  warnings: z.array(z.string()).default([]),
});

export type BrowserResult = z.infer<typeof browserResultSchema>;

/* ------------------------------------------------------------------ */
/* Host-side shapes                                                     */
/* ------------------------------------------------------------------ */

/** What `capturePage` returns. */
export interface PageCapture {
  url: string;
  finalUrl: string;
  title: string;
  axTree: AxTree;
  /** Base64 PNG. Downloaded from the sandbox rather than carried over stdout. */
  screenshot: string | null;
  axeViolations: AxeViolation[];
  links: string[];
  warnings: string[];
}

/** One changed state property on a node present in both trees. */
export interface ChangedProp {
  nodeId: string;
  role: string | null;
  name: string | null;
  prop: AxStateProp;
  before: string | null;
  after: string | null;
}

/**
 * The output of `diffTrees`.
 *
 * `nodesAdded.length` is the number the demo turns on: +98 on the Clearway
 * language control, with `changedProps` empty for that control's own state.
 */
export interface TreeDiff {
  nodesAdded: AxNode[];
  nodesRemoved: AxNode[];
  changedProps: ChangedProp[];
  addedCount: number;
  removedCount: number;
  changedCount: number;
  /** after.size - before.size. The headline delta. */
  sizeDelta: number;
  /**
   * Fraction of `before` node ids still present in `after`, 0..1.
   *
   * CDP reassigns AXNodeIds when a subtree is rebuilt. A low value means the ids
   * churned and the added/removed lists overstate the real change, so the
   * analysis layer should lean on `sizeDelta` instead. 1 means ids were stable.
   */
  idStability: number;
}
