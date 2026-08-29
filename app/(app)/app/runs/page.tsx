import Link from "next/link";

import { Icon } from "@/components/Icon";
import { StatusLabel } from "@/components/StatusLabel";
import { formatUtcDate, runStatusLabel } from "@/components/run-data";

import { listRuns, requireSessionUser } from "../../_data";

export const metadata = { title: "Runs" };
export const dynamic = "force-dynamic";

const phaseLabels: Record<"baseline" | "final", string> = {
  baseline: "Baseline audit",
  final: "Final audit",
};

/**
 * Every run the signed-in user owns, newest first, read from the ledger.
 *
 * A failed run states its reason on the row rather than hiding it behind the
 * detail page: "failed" without a reason is the thing this product exists to
 * stop other tools doing.
 */
export default async function RunsPage() {
  const user = await requireSessionUser("/app/runs");
  const runs = await listRuns(user.id);

  return (
    <main id="main-content" className="dashboard-page">
      <div className="page-header">
        <div>
          <span className="eyebrow">Ledger</span>
          <h1>Runs</h1>
          <p>
            One run is one complete pass: baseline score, fixes, verification, final score. A run
            resumes from the ledger rather than restarting.
          </p>
        </div>
        <div className="page-action-row">
          <Link className="button primary" href="/app/targets">
            Start a run
            <Icon name="play" size={15} />
          </Link>
        </div>
      </div>

      <h2 className="sr-only">All runs</h2>

      {runs.length === 0 ? (
        <div className="quiet-panel">
          <Icon name="activity" size={22} />
          <strong>No runs yet</strong>
          <span>
            Nothing has been audited on this account. Connect a target and start a run; this list
            fills in from the ledger.
          </span>
        </div>
      ) : (
        <div className="record-list">
          {runs.map((run) => (
            <Link className="record-row" key={run.id} href={`/app/runs/${run.id}`}>
              <span className="record-main">
                <strong>{run.repoFullName}</strong>
                <small>
                  {phaseLabels[run.phase]} · started {formatUtcDate(run.startedAt ?? run.createdAt)}{" "}
                  · {run.findingCount} finding{run.findingCount === 1 ? "" : "s"}
                  {run.failureReason ? ` · stopped: ${run.failureReason}` : ""}
                </small>
              </span>
              <StatusLabel value={runStatusLabel(run.status)} />
              <Icon name="chevron-right" className="record-arrow" />
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
