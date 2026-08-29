import { StatusLabel, type StatusValue } from "./StatusLabel";

export type RunPhase = "baseline" | "fix" | "verify" | "final";

export type RunSummary = {
  status: StatusValue;
  phase: RunPhase;
  sandboxesUsed: number;
  maxSandboxes: number;
  activeModel: string;
  /** Optional human-readable elapsed time, e.g. "4m 12s". */
  elapsed?: string;
};

const phaseLabels: Record<RunPhase, string> = {
  baseline: "Baseline audit",
  fix: "Writing fixes",
  verify: "Verification",
  final: "Final audit",
};

/**
 * RunSummaryBar — requirement A11.2.
 *
 * Accessibility contract:
 * - A definition list, so each fact keeps its label when linearised.
 * - The sandbox meter is decorative; the ratio is always spelled out in text.
 * - A single polite live region restates the run state so a status change is
 *   announced without moving focus.
 */
export function RunSummaryBar({ run }: { run: RunSummary }) {
  const ratio = run.maxSandboxes > 0 ? Math.min(1, run.sandboxesUsed / run.maxSandboxes) : 0;

  return (
    <>
      <dl className="run-summary-bar">
        <div>
          <dt>Run state</dt>
          <dd>
            <StatusLabel value={run.status} />
          </dd>
        </div>

        <span className="summary-divider" aria-hidden="true" />

        <div>
          <dt>Phase</dt>
          <dd>{phaseLabels[run.phase]}</dd>
        </div>

        <span className="summary-divider" aria-hidden="true" />

        <div>
          <dt>Sandboxes</dt>
          <dd>
            {run.sandboxesUsed} of {run.maxSandboxes} in use
            <span className="meter" aria-hidden="true">
              <i style={{ width: `${Math.round(ratio * 100)}%` }} />
            </span>
          </dd>
        </div>

        <span className="summary-divider" aria-hidden="true" />

        <div>
          <dt>Active model</dt>
          <dd>
            <code>{run.activeModel}</code>
          </dd>
        </div>

        {run.elapsed ? (
          <>
            <span className="summary-spacer" />
            <div>
              <dt>Elapsed</dt>
              <dd>{run.elapsed}</dd>
            </div>
          </>
        ) : null}
      </dl>

      <p className="sr-only" aria-live="polite">
        {`Run ${String(run.status).replace(/_/g, " ")}. ${phaseLabels[run.phase]}. ` +
          `${run.sandboxesUsed} of ${run.maxSandboxes} sandboxes in use. Model ${run.activeModel}.`}
      </p>
    </>
  );
}
