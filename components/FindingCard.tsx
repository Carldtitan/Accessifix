"use client";

import { useId, useState } from "react";
import { Icon } from "./Icon";
import { StatusLabel } from "./StatusLabel";
import type { CriterionLevel, CriterionVerdict } from "./CriterionMatrix";

export type FindingSeverity = "critical" | "serious" | "moderate" | "minor";
export type FindingStatus = "open" | "fixing" | "fixed" | "verified" | "dismissed";
export type AuditAgent = "TREE" | "VIS" | "ACT" | "PAGES" | "MEDIA" | "CODE" | "FIX" | "VERIFY";

export type TreeComparison = {
  /** Accessibility tree excerpt before the interaction. */
  before: string;
  /** Accessibility tree excerpt after the interaction. */
  after: string;
  /** What the interaction was, in plain language. */
  interaction: string;
  /** Why the diff is a violation. */
  note?: string;
};

export type Finding = {
  id: string;
  criterion: string;
  criterionName: string;
  level: CriterionLevel;
  verdict: CriterionVerdict;
  severity: FindingSeverity;
  status: FindingStatus;
  pageUrl: string;
  summary: string;
  agent: AuditAgent;
  sourcePath?: string;
  /** Present for the twelve state criteria (A9.3). */
  tree?: TreeComparison;
};

/**
 * FindingCard — one violation of one criterion on one page, with its evidence.
 *
 * Accessibility contract:
 * - The tree comparison is a disclosure. `aria-expanded` on the trigger tracks
 *   the real state and `aria-controls` points at a panel that stays in the DOM
 *   and is toggled with the `hidden` attribute. This product detects exactly
 *   the bug of a control whose state attribute does not change; it must not
 *   commit it.
 * - Each tree pane is a labelled, keyboard-scrollable region (WCAG 2.1.1).
 * - Severity, verdict and status are words, not colours.
 */
export function FindingCard({ finding }: { finding: Finding }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const hasTree = Boolean(finding.tree);

  return (
    <article className="finding-card">
      <div className="finding-head">
        <span className="criterion-badge">
          <Icon name="check" size={14} />
          <code>SC {finding.criterion}</code>
          {finding.criterionName}
        </span>
        <span className="level-tag">Level {finding.level}</span>
        <StatusLabel value={finding.severity} prefix="Severity:" />
        <StatusLabel value={finding.verdict} />
        <StatusLabel value={finding.status} />
      </div>

      <p className="finding-summary">{finding.summary}</p>

      <p className="finding-meta">
        <span>
          Page <strong className="finding-url">{finding.pageUrl}</strong>
        </span>
        <span>
          Claimed by <strong>{finding.agent}</strong>
        </span>
        {finding.sourcePath ? (
          <span>
            Source <strong className="finding-url">{finding.sourcePath}</strong>
          </span>
        ) : null}
      </p>

      {hasTree && finding.tree ? (
        <>
          <button
            type="button"
            className="disclosure-trigger"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen((value) => !value)}
          >
            <Icon name="chevron" size={15} />
            {open ? "Hide" : "Show"} accessibility tree, before and after
          </button>

          <div id={panelId} hidden={!open}>
            <p className="finding-meta" style={{ marginBottom: 10 }}>
              <span>
                Interaction <strong>{finding.tree.interaction}</strong>
              </span>
            </p>
            <div className="tree-compare">
              <section className="tree-pane">
                <h4 id={`${panelId}-before`}>Before interaction</h4>
                <pre tabIndex={0} role="region" aria-labelledby={`${panelId}-before`}>
                  {finding.tree.before}
                </pre>
              </section>
              <section className="tree-pane">
                <h4 id={`${panelId}-after`}>After interaction</h4>
                <pre tabIndex={0} role="region" aria-labelledby={`${panelId}-after`}>
                  {finding.tree.after}
                </pre>
              </section>
            </div>
            {finding.tree.note ? (
              <p className="finding-meta" style={{ marginTop: 10 }}>
                <span>{finding.tree.note}</span>
              </p>
            ) : null}
          </div>
        </>
      ) : null}
    </article>
  );
}
