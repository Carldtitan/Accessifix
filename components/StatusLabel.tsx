/**
 * StatusLabel — the one pill used for run states, environment states,
 * finding states, verdicts and severities.
 *
 * Accessibility contract:
 * - State is carried by the visible text, never by the tint alone (WCAG 1.4.1).
 * - The dot is decorative and hidden from assistive technology.
 * - Every ink/tint pair is verified at 4.5:1 or better. See the contrast
 *   ledger at the top of app/globals.css.
 */

export type StatusTone = "live" | "done" | "attention" | "blocked" | "queued" | "neutral";

/** Run lifecycle, environment lifecycle, finding lifecycle, verdicts, severities. */
export type StatusValue =
  // run
  | "queued"
  | "crawling"
  | "auditing"
  | "fixing"
  | "verifying"
  | "scoring"
  | "awaiting_approval"
  | "complete"
  | "failed"
  | "paused"
  // environment
  | "live"
  | "running"
  | "done"
  | "provisioning"
  // finding
  | "open"
  | "fixed"
  | "verified"
  | "dismissed"
  // verdict
  | "DECIDE"
  | "FLAG"
  | "BLOCKED"
  // criterion state, as the score reports it (lib/pipeline/score.ts)
  | "passing"
  | "failing"
  | "flagged"
  | "blocked"
  // severity
  | "critical"
  | "serious"
  | "moderate"
  | "minor";

const tones: Record<StatusValue, StatusTone> = {
  queued: "queued",
  crawling: "live",
  auditing: "live",
  fixing: "live",
  verifying: "live",
  scoring: "live",
  awaiting_approval: "attention",
  complete: "done",
  failed: "blocked",
  paused: "attention",

  live: "live",
  running: "live",
  done: "done",
  provisioning: "queued",

  open: "attention",
  fixed: "neutral",
  verified: "done",
  dismissed: "queued",

  DECIDE: "done",
  FLAG: "attention",
  BLOCKED: "blocked",

  passing: "done",
  failing: "blocked",
  flagged: "attention",
  blocked: "blocked",

  critical: "blocked",
  serious: "attention",
  moderate: "neutral",
  minor: "queued",
};

const labels: Partial<Record<StatusValue, string>> = {
  awaiting_approval: "Awaiting approval",
  DECIDE: "Decide",
  FLAG: "Flag",
  BLOCKED: "Blocked",
};

function toLabel(value: StatusValue): string {
  const preset = labels[value];
  if (preset) return preset;
  const words = value.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function StatusLabel({
  value,
  prefix,
  tone,
}: {
  value: StatusValue;
  /** Optional visually-included qualifier, e.g. "Severity". */
  prefix?: string;
  /** Override the derived tone. Rarely needed. */
  tone?: StatusTone;
}) {
  const resolvedTone = tone ?? tones[value] ?? "neutral";
  return (
    <span className={`status-label status-${resolvedTone}`}>
      <i aria-hidden="true" />
      {prefix ? `${prefix} ` : ""}
      {toLabel(value)}
    </span>
  );
}

export function statusTone(value: StatusValue): StatusTone {
  return tones[value] ?? "neutral";
}
