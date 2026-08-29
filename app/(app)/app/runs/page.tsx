import Link from "next/link";
import { Icon } from "@/components/Icon";
import { StatusLabel } from "@/components/StatusLabel";
import { sampleRuns } from "@/components/sample-data";

export const metadata = { title: "Runs" };

const phaseLabels = {
  baseline: "Baseline audit",
  fix: "Writing fixes",
  verify: "Verification",
  final: "Final audit",
} as const;

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(new Date(iso));
}

export default function RunsPage() {
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
      <div className="record-list">
        {sampleRuns.map((run) => (
          <Link className="record-row" key={run.id} href={`/app/runs/${run.id}`}>
            <span className="record-main">
              <strong>{run.id}</strong>
              <small>
                {run.target} · {phaseLabels[run.phase]} · started {formatDate(run.startedAt)} UTC ·{" "}
                {run.findings} findings
              </small>
            </span>
            <StatusLabel value={run.status} />
            <Icon name="chevron-right" className="record-arrow" />
          </Link>
        ))}
      </div>

      <p className="muted" style={{ marginTop: 18, fontSize: 13 }}>
        Placeholder data. Runs will be read from the findings ledger.
      </p>
    </main>
  );
}
