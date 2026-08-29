/* =====================================================================
   PLACEHOLDER DATA — NOT A DATA SOURCE.

   Everything in this file is static sample content so the interface can
   be built, reviewed and demonstrated before the ledger exists. It is
   deliberately self-contained: nothing here imports from lib/db.

   When the ledger lands, delete this file and feed the same shapes from
   queries over the findings table.
   ===================================================================== */

import type { BrowserEnvironment } from "./EnvironmentGrid";
import type { CriterionRow, CriterionVerdict } from "./CriterionMatrix";
import type { Finding } from "./FindingCard";
import type { TimelineEvent } from "./AgentTimeline";
import type { Patch } from "./DiffCard";
import type { Approval } from "./ApprovalCard";
import type { RunSummary } from "./RunSummaryBar";
import { WCAG_AA_CRITERIA } from "./CriterionMatrix";

export const SAMPLE_TARGET = {
  name: "Clearway",
  repository: "clearway-benefits/clearway",
  deployedUrl: "https://clearway.example.gov",
  description: "SSDI benefits application. The reference audit target.",
};

export const sampleRun: RunSummary = {
  status: "auditing",
  phase: "baseline",
  sandboxesUsed: 6,
  maxSandboxes: 8,
  activeModel: "claude-sonnet-4-6",
  elapsed: "4m 12s",
};

export const sampleEnvironments: ReadonlyArray<BrowserEnvironment> = [
  {
    id: "env-1",
    engine: "Chromium 1280x720",
    pathLabel: "Expand “What counts as a disability?”",
    pathTemplate: "Toggle",
    criterion: "4.1.2",
    state: "live",
    capturedAt: "2s ago",
    findings: 1,
  },
  {
    id: "env-2",
    engine: "Chromium 1280x720",
    pathLabel: "Open the “Upload medical records” dialog",
    pathTemplate: "Dialog",
    criterion: "2.4.3",
    state: "live",
    capturedAt: "4s ago",
    findings: 0,
  },
  {
    id: "env-3",
    engine: "Chromium 1280x720",
    pathLabel: "Submit the applicant details form empty",
    pathTemplate: "Form",
    criterion: "3.3.1",
    state: "live",
    capturedAt: "1s ago",
    findings: 2,
  },
  {
    id: "env-4",
    engine: "Chromium 390x844",
    pathLabel: "Toggle the benefits calculator switch",
    pathTemplate: "Toggle",
    criterion: "4.1.2",
    state: "done",
    capturedAt: "38s ago",
    findings: 1,
  },
  {
    id: "env-5",
    engine: "Chromium 1280x720",
    pathLabel: "Crawl same-origin routes from the landing page",
    pathTemplate: "Crawl",
    state: "done",
    capturedAt: "2m ago",
    findings: 0,
  },
  {
    id: "env-6",
    engine: "Chromium 1280x720",
    pathLabel: "Screenshot pass over the appeals wizard",
    pathTemplate: "Vision",
    state: "live",
    capturedAt: "6s ago",
    findings: 3,
  },
  {
    id: "env-7",
    engine: "Chromium 1280x720",
    pathLabel: "Open the session timeout warning",
    pathTemplate: "Dialog",
    criterion: "2.2.1",
    state: "queued",
    findings: 0,
  },
  {
    id: "env-8",
    engine: "Chromium 1280x720",
    pathLabel: "Expand the “Appeal deadlines” accordion",
    pathTemplate: "Toggle",
    criterion: "4.1.2",
    state: "queued",
    findings: 0,
  },
];

/** Criteria failing the baseline, with the number of findings against each. */
const baselineFailures: Record<string, number> = {
  "1.1.1": 4,
  "1.3.1": 6,
  "1.4.3": 11,
  "1.4.11": 3,
  "2.1.1": 2,
  "2.4.4": 3,
  "2.4.7": 1,
  "2.4.11": 1,
  "2.5.8": 5,
  "3.1.2": 1,
  "3.3.2": 2,
  "4.1.2": 9,
  "4.1.3": 2,
};

/** Failures that stay with a human after the fix pass. */
const stillFlagged = new Set(["1.1.1", "3.1.2"]);

/** A2.4 — reported as blocked with a reason, never as passing. */
const blockedCriteria = new Set(["1.2.4", "3.3.4"]);

export const sampleCriterionRows: ReadonlyArray<CriterionRow> = WCAG_AA_CRITERIA.map((criterion) => {
  const findings = baselineFailures[criterion.id] ?? 0;
  const blocked = blockedCriteria.has(criterion.id);
  const baseline: CriterionVerdict = blocked ? "BLOCKED" : findings > 0 ? "FLAG" : "DECIDE";
  const final: CriterionVerdict = blocked
    ? "BLOCKED"
    : stillFlagged.has(criterion.id)
      ? "FLAG"
      : "DECIDE";
  return { ...criterion, baseline, final, findings };
});

export const sampleScore = {
  criteriaFailingBaseline: Object.keys(baselineFailures).length,
  criteriaFailingFinal: stillFlagged.size,
  findingsTotal: Object.values(baselineFailures).reduce((total, count) => total + count, 0),
  findingsResolved: Object.entries(baselineFailures)
    .filter(([id]) => !stillFlagged.has(id))
    .reduce((total, [, count]) => total + count, 0),
  blocked: blockedCriteria.size,
};

export const sampleFindings: ReadonlyArray<Finding> = [
  {
    id: "f-4012",
    criterion: "4.1.2",
    criterionName: "Name, Role, Value",
    level: "A",
    verdict: "DECIDE",
    severity: "critical",
    status: "open",
    pageUrl: "https://clearway.example.gov/eligibility",
    summary:
      "The “What counts as a disability?” accordion header opens and closes its panel, but aria-expanded stays false. A screen reader announces the control as collapsed while the panel is open.",
    agent: "ACT",
    sourcePath: "components/Accordion.tsx:41",
    tree: {
      interaction: "Click the accordion header, then re-read the accessibility tree",
      before: `button "What counts as a disability?"
  expanded: false
  focusable: true
group "eligibility-panel"
  hidden: true`,
      after: `button "What counts as a disability?"
  expanded: false        <-- unchanged
  focusable: true
group "eligibility-panel"
  hidden: false          <-- changed
  child: text "A disability is..."`,
      note: "The tree changed but the control's own state attribute did not. That is the 4.1.2 failure pattern described in A4.4.",
    },
  },
  {
    id: "f-1403",
    criterion: "1.4.3",
    criterionName: "Contrast (Minimum)",
    level: "AA",
    verdict: "DECIDE",
    severity: "serious",
    status: "fixing",
    pageUrl: "https://clearway.example.gov/apply/step-2",
    summary:
      "Helper text under every form field renders #9b9b9b on #f7f7f7, measuring 2.6:1. Eleven fields across four pages use the same token.",
    agent: "TREE",
    sourcePath: "app/styles/tokens.css:18",
  },
  {
    id: "f-1311",
    criterion: "1.3.1",
    criterionName: "Info and Relationships",
    level: "A",
    verdict: "DECIDE",
    severity: "serious",
    status: "verified",
    pageUrl: "https://clearway.example.gov/appeals",
    summary:
      "The appeals deadline table uses styled divs. No row or column relationships reach assistive technology, so a deadline cannot be tied to the stage it belongs to.",
    agent: "TREE",
    sourcePath: "app/appeals/DeadlineTable.tsx:12",
  },
  {
    id: "f-1111",
    criterion: "1.1.1",
    criterionName: "Non-text Content",
    level: "A",
    verdict: "FLAG",
    severity: "moderate",
    status: "open",
    pageUrl: "https://clearway.example.gov/",
    summary:
      "Four illustrations carry empty alt text. Whether they are decorative or carry meaning is an editorial judgement, so this is routed to the human queue rather than auto-fixed.",
    agent: "VIS",
  },
  {
    id: "f-2508",
    criterion: "2.5.8",
    criterionName: "Target Size (Minimum)",
    level: "AA",
    verdict: "DECIDE",
    severity: "moderate",
    status: "fixed",
    pageUrl: "https://clearway.example.gov/apply/step-3",
    summary:
      "The remove-document buttons are 18 by 18 CSS pixels with no spacing exception, below the 24 by 24 minimum.",
    agent: "TREE",
    sourcePath: "components/DocumentRow.tsx:57",
  },
  {
    id: "f-3301",
    criterion: "3.3.1",
    criterionName: "Error Identification",
    level: "A",
    verdict: "DECIDE",
    severity: "critical",
    status: "open",
    pageUrl: "https://clearway.example.gov/apply/step-1",
    summary:
      "Submitting the applicant form empty paints every field red and moves focus nowhere. No error text is added to the accessibility tree and nothing is announced.",
    agent: "ACT",
    sourcePath: "app/apply/step-1/form.tsx:88",
    tree: {
      interaction: "Submit the form with every field empty",
      before: `form "Applicant details"
  textbox "Full name" required: true
  textbox "Date of birth" required: true
  button "Continue"`,
      after: `form "Applicant details"
  textbox "Full name" required: true
    invalid: false        <-- unchanged
  textbox "Date of birth" required: true
    invalid: false        <-- unchanged
  button "Continue"
(no alert, no status, no describedby)`,
      note: "The failure is visual only. Nothing in the tree tells a non-sighted applicant which field was rejected.",
    },
  },
];

export const samplePatches: ReadonlyArray<Patch> = [
  {
    id: "p-1",
    path: "components/Accordion.tsx",
    covers: ["4.1.2"],
    diff: `@@ -38,9 +38,10 @@ export function Accordion({ title, children }: Props) {
   const [open, setOpen] = useState(false);
   return (
     <div className="accordion">
-      <button className="accordion-header" onClick={() => setOpen(!open)}>
+      <button
+        className="accordion-header"
+        aria-expanded={open}
+        aria-controls={panelId}
+        onClick={() => setOpen(!open)}
+      >
         {title}
       </button>
-      <div className="accordion-panel" hidden={!open}>
+      <div id={panelId} className="accordion-panel" hidden={!open}>
         {children}
       </div>`,
  },
  {
    id: "p-2",
    path: "app/styles/tokens.css",
    covers: ["1.4.3", "1.4.11"],
    diff: `@@ -15,8 +15,8 @@
 :root {
   --field-label: #4a4a4a;
-  --field-helper: #9b9b9b;   /* 2.6:1 on --surface */
-  --field-border: #d8d8d8;   /* 1.5:1 on --surface */
+  --field-helper: #595959;   /* 7.0:1 on --surface */
+  --field-border: #767676;   /* 3.1:1 on --surface */
   --surface: #f7f7f7;
 }`,
  },
];

export const sampleTimeline: ReadonlyArray<TimelineEvent> = [
  {
    id: "t-1",
    agent: "APP",
    summary: "Run opened against clearway.example.gov",
    detail: "Deployed URL returned 200. Baseline phase created in the ledger.",
    timestamp: "2026-08-29T09:14:02Z",
    capability: "ledger",
  },
  {
    id: "t-2",
    agent: "APP",
    summary: "Crawled 14 same-origin pages",
    detail: "One browser sandbox, page cap 20.",
    timestamp: "2026-08-29T09:14:51Z",
    capability: "sandbox",
  },
  {
    id: "t-3",
    agent: "TREE",
    summary: "Deterministic checks resolved 16 criteria with no model call",
    detail: "axe-core in-page plus a full accessibility tree snapshot per page.",
    timestamp: "2026-08-29T09:15:30Z",
    capability: "skill",
  },
  {
    id: "t-4",
    agent: "VIS",
    summary: "Vision found 3 controls the accessibility tree does not expose",
    detail: "Div-buttons in the appeals wizard. Recorded immediately as findings (A4.2).",
    timestamp: "2026-08-29T09:16:12Z",
    capability: "model",
  },
  {
    id: "t-5",
    agent: "ACT",
    summary: "Dispatched 24 interaction paths to subagents",
    detail: "Toggle, Dialog and Form templates at depth one. Six browser sandboxes in parallel.",
    timestamp: "2026-08-29T09:16:40Z",
    capability: "subagent",
  },
  {
    id: "t-6",
    agent: "ACT",
    summary: "4.1.2 finding on the eligibility accordion",
    detail: "Tree changed, aria-expanded did not.",
    timestamp: "2026-08-29T09:17:09Z",
    capability: "sandbox",
  },
  {
    id: "t-7",
    agent: "FIX",
    summary: "Two patches written, batched per source file",
    detail: "Covers 4.1.2, 1.4.3 and 1.4.11. DECIDE findings only.",
    timestamp: "2026-08-29T09:21:33Z",
    capability: "sandbox",
  },
  {
    id: "t-8",
    agent: "VERIFY",
    summary: "Target test suite passed, 148 tests",
    detail: "Build sandbox at 4 CPU / 8 GB. Fixed criteria re-checked.",
    timestamp: "2026-08-29T09:26:04Z",
    capability: "sandbox",
  },
  {
    id: "t-9",
    agent: "APP",
    summary: "Paused before pushing a branch",
    detail: "Write-class tool call held for a human decision.",
    timestamp: "2026-08-29T09:26:20Z",
    capability: "approval",
  },
];

export const sampleApproval: Approval = {
  id: "handoff-1",
  title: "Push a branch and open a pull request",
  intent:
    "I want to push accessifix/wcag-fixes-2026-08-29 to clearway-benefits/clearway and open a pull request containing two patches across two files. Nothing has been pushed yet.",
  reason:
    "Both patches address DECIDE findings only, and the repository's own test suite passed on the patched tree. The pull request is the first irreversible step, so it needs your sign-off before anything leaves this machine.",
  toolName: "github.create_pull_request",
  waitingFor: "3 minutes",
  evidence: [
    {
      id: "e-1",
      kind: "test",
      label: "Target test suite passed",
      detail: "148 tests, 0 failures, vitest, build sandbox 4 CPU / 8 GB",
    },
    {
      id: "e-2",
      kind: "diff",
      label: "2 patches across 2 files",
      detail: "components/Accordion.tsx, app/styles/tokens.css",
    },
    {
      id: "e-3",
      kind: "criterion",
      label: "3 criteria re-checked and now passing",
      detail: "4.1.2 Name Role Value, 1.4.3 Contrast, 1.4.11 Non-text Contrast",
    },
    {
      id: "e-4",
      kind: "tree",
      label: "Before and after accessibility tree for the accordion",
      detail: "aria-expanded now tracks the panel",
    },
  ],
};

export type RunRecord = {
  id: string;
  target: string;
  status: RunSummary["status"];
  phase: RunSummary["phase"];
  startedAt: string;
  findings: number;
};

export const sampleRuns: ReadonlyArray<RunRecord> = [
  {
    id: "run_2026_08_29_a",
    target: "clearway.example.gov",
    status: "auditing",
    phase: "baseline",
    startedAt: "2026-08-29T09:14:02Z",
    findings: 50,
  },
  {
    id: "run_2026_08_28_c",
    target: "clearway.example.gov",
    status: "complete",
    phase: "final",
    startedAt: "2026-08-28T16:02:44Z",
    findings: 8,
  },
  {
    id: "run_2026_08_28_b",
    target: "clearway.example.gov",
    status: "awaiting_approval",
    phase: "fix",
    startedAt: "2026-08-28T11:37:19Z",
    findings: 31,
  },
  {
    id: "run_2026_08_27_a",
    target: "clearway.example.gov",
    status: "failed",
    phase: "verify",
    startedAt: "2026-08-27T14:20:05Z",
    findings: 44,
  },
];

export type TargetRecord = {
  id: string;
  name: string;
  repository: string;
  deployedUrl: string;
  reachable: boolean;
  lastRun?: string;
};

export const sampleTargets: ReadonlyArray<TargetRecord> = [
  {
    id: "target-1",
    name: "Clearway",
    repository: "clearway-benefits/clearway",
    deployedUrl: "https://clearway.example.gov",
    reachable: true,
    lastRun: "run_2026_08_29_a",
  },
  {
    id: "target-2",
    name: "Clearway staging",
    repository: "clearway-benefits/clearway",
    deployedUrl: "https://staging.clearway.example.gov",
    reachable: false,
  },
];
