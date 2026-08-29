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
  /** The handoff row this card answers. Sent to the harness as `handoffId`. */
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

/** idle -> submitting -> settled, or submitting -> error and back for a retry. */
type SubmitState = "idle" | "submitting" | "settled" | "error";

/**
 * ApprovalCard - the handoff (A7). The agent stops here and asks.
 *
 * The decision releases an irreversible action, so this card never reports an
 * outcome it did not obtain. A click answers the run's handoff through
 * `POST /api/runs/{runId}/approve` (or through `onDecision`, when the caller
 * owns the operation). The outcome banner appears only once that call has
 * succeeded; a failure is surfaced and the buttons come back for a retry; and a
 * card given neither a run nor a handler keeps its controls disabled and says
 * so, rather than miming a decision that reached nothing.
 *
 * Accessibility contract:
 * - One heading, one paragraph of intent, one of reason, then the evidence.
 *   The ask is written prose, never a raw tool payload.
 * - Approve and Reject are real buttons with distinct accessible names.
 * - In flight the buttons are `aria-disabled` rather than `disabled`, so the
 *   button the user just pressed keeps focus; progress is announced politely.
 * - A failure is announced through `role="alert"` and does not move focus, so a
 *   keyboard user retries from where they already are.
 * - After a decision the buttons stay in the DOM but are disabled, and focus
 *   moves deliberately to the outcome banner, so a keyboard user is never
 *   dropped back to the top of the document.
 * - The waiting reminder is a polite live region; it never steals focus.
 */
export function ApprovalCard({
  approval,
  runId,
  onDecision,
}: {
  approval: Approval;
  /** The run this handoff belongs to. Without it there is nothing to answer. */
  runId?: string;
  /** Replaces the default request when the caller owns the decision. */
  onDecision?: (decision: Decision, approvalId: string) => void | Promise<void>;
}) {
  const [decision, setDecision] = useState<Decision | null>(null);
  const [status, setStatus] = useState<SubmitState>("idle");
  const [error, setError] = useState<string | null>(null);
  const outcomeRef = useRef<HTMLParagraphElement | null>(null);

  const canDecide = Boolean(onDecision) || Boolean(runId);
  const busy = status === "submitting";
  const settled = status === "settled" && decision !== null;
  const locked = !canDecide || busy || settled;

  async function send(next: Decision): Promise<void> {
    if (onDecision) {
      await onDecision(next, approval.id);
      return;
    }

    const response = await fetch(`/api/runs/${encodeURIComponent(runId as string)}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        handoffId: approval.id,
        decision: next === "approved" ? "approve" : "reject",
      }),
    });

    let body: { error?: string; reason?: string } | null = null;
    try {
      body = (await response.json()) as { error?: string; reason?: string };
    } catch {
      body = null;
    }

    if (!response.ok) {
      const detail = [body?.error, body?.reason].filter(Boolean).join(" ");
      throw new Error(
        detail || `The decision was not recorded. The harness answered ${response.status}.`,
      );
    }
  }

  function decide(next: Decision) {
    if (locked) return;
    setStatus("submitting");
    setError(null);
    void send(next).then(
      () => {
        setDecision(next);
        setStatus("settled");
        // Deliberate focus move on a user-initiated action, not on a status update.
        requestAnimationFrame(() => outcomeRef.current?.focus());
      },
      (cause: unknown) => {
        setStatus("error");
        setError(
          cause instanceof Error && cause.message
            ? cause.message
            : "The decision could not be recorded.",
        );
      },
    );
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

      {settled && decision ? (
        <p className="approval-resolved" tabIndex={-1} ref={outcomeRef}>
          <Icon name={decision === "approved" ? "check" : "close"} size={18} />
          {decision === "approved"
            ? "Approved. The decision is recorded against the run, and the agent continues."
            : "Rejected. The decision is recorded, and the agent stops before the write and returns the findings to the queue."}
        </p>
      ) : null}

      {status === "error" && error ? (
        <p className="approval-error" role="alert">
          <Icon name="warning" size={17} />
          <span>{error} Nothing has been written, and the decision is still open.</span>
        </p>
      ) : null}

      <div className="approval-actions">
        <button
          type="button"
          className="button primary"
          onClick={() => decide("approved")}
          disabled={!canDecide || settled}
          aria-disabled={locked || undefined}
        >
          Approve
          <Icon name="check" size={15} />
        </button>
        <button
          type="button"
          className="button reject"
          onClick={() => decide("rejected")}
          disabled={!canDecide || settled}
          aria-disabled={locked || undefined}
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

      {busy ? (
        <p className="approval-note" role="status">
          Recording your decision with the harness.
        </p>
      ) : null}

      {!canDecide ? (
        <p className="approval-note">
          <Icon name="warning" size={14} /> This card is not bound to a run, so there is no handoff
          to answer. The controls stay disabled rather than reporting a decision that reached
          nothing.
        </p>
      ) : null}

      {approval.waitingFor && status === "idle" ? (
        <p className="approval-note" aria-live="polite">
          <Icon name="warning" size={14} /> Waiting {approval.waitingFor} for a decision.
        </p>
      ) : null}
    </section>
  );
}
