"use client";

import { useRef, useState } from "react";
import { Icon, type IconName } from "./Icon";

export type ApprovalEvidenceKind = "screenshot" | "tree" | "source" | "test" | "diff" | "criterion";

export type ApprovalEvidence = {
  id: string;
  kind: ApprovalEvidenceKind;
  label: string;
  detail?: string;
  href?: string;
};

export type Approval = {
  id: string;
  /** Short name of the irreversible action, e.g. "Open a pull request". */
  title: string;
  /** What the agent intends to do, written for a human (A7.3). */
  intent: string;
  /** Why it wants to do it. */
  reason: string;
  /** What supports it (A7.2). */
  evidence: ReadonlyArray<ApprovalEvidence>;
  /** The write-class tool the harness paused on. Shown quietly, not as the ask. */
  toolName?: string;
  /** How long it has been waiting. Drives the reminder in A7.5. */
  waitingFor?: string;
};

const evidenceIcons: Record<ApprovalEvidenceKind, IconName> = {
  screenshot: "image",
  tree: "tree",
  source: "code",
  test: "check",
  diff: "code",
  criterion: "target",
};

type Decision = "approved" | "rejected";

/**
 * ApprovalCard — the handoff (A7). The agent stops here and asks.
 *
 * Accessibility contract:
 * - One heading, one paragraph of intent, one of reason, then the evidence.
 *   The ask is written prose, never a raw tool payload.
 * - Approve and Reject are real buttons with distinct accessible names.
 * - After a decision the buttons stay in the DOM but are disabled, and focus
 *   moves deliberately to the outcome banner, so a keyboard user is never
 *   dropped back to the top of the document.
 * - The waiting reminder is a polite live region; it never steals focus.
 */
export function ApprovalCard({
  approval,
  onDecision,
}: {
  approval: Approval;
  onDecision?: (decision: Decision, approvalId: string) => void;
}) {
  const [decision, setDecision] = useState<Decision | null>(null);
  const outcomeRef = useRef<HTMLParagraphElement | null>(null);

  function decide(next: Decision) {
    setDecision(next);
    onDecision?.(next, approval.id);
    // Deliberate focus move on a user-initiated action, not on a status update.
    requestAnimationFrame(() => outcomeRef.current?.focus());
  }

  return (
    <section className="approval-card" aria-labelledby={`${approval.id}-title`}>
      <header className="approval-head">
        <span className="eyebrow">Approval required</span>
        <h2 id={`${approval.id}-title`}>{approval.title}</h2>
        <p className="approval-intent">{approval.intent}</p>
      </header>

      <div className="approval-block">
        <h3>Why</h3>
        <p>{approval.reason}</p>
      </div>

      <div className="approval-block">
        <h3>Evidence</h3>
        <ul className="evidence-list">
          {approval.evidence.map((item) => (
            <li key={item.id}>
              <Icon name={evidenceIcons[item.kind]} size={17} />
              <span>
                <strong>{item.label}</strong>
                {item.detail ? <small>{item.detail}</small> : null}
              </span>
              {item.href ? (
                <a href={item.href} target="_blank" rel="noreferrer">
                  Open<span className="sr-only"> {item.label} in a new tab</span>
                </a>
              ) : (
                <span className="muted" style={{ fontSize: 12 }}>
                  On record
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>

      {decision ? (
        <p className="approval-resolved" tabIndex={-1} ref={outcomeRef}>
          <Icon name={decision === "approved" ? "check" : "close"} size={18} />
          {decision === "approved"
            ? "Approved. The agent will continue and record this decision against the run."
            : "Rejected. The agent will stop before the write and return the findings to the queue."}
        </p>
      ) : null}

      <div className="approval-actions">
        <button
          type="button"
          className="button primary"
          onClick={() => decide("approved")}
          disabled={decision !== null}
        >
          Approve
          <Icon name="check" size={15} />
        </button>
        <button
          type="button"
          className="button reject"
          onClick={() => decide("rejected")}
          disabled={decision !== null}
        >
          Reject
        </button>
        <span className="approval-note">
          {approval.toolName ? (
            <>
              Paused on <code>{approval.toolName}</code>.{" "}
            </>
          ) : null}
          Nothing is written until you decide. The run survives a reload while it waits.
        </span>
      </div>

      {approval.waitingFor && decision === null ? (
        <p className="approval-note" aria-live="polite">
          <Icon name="warning" size={14} /> Waiting {approval.waitingFor} for a decision.
        </p>
      ) : null}
    </section>
  );
}
