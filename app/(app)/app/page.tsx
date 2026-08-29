import Link from "next/link";
import { EnvironmentGrid } from "@/components/EnvironmentGrid";
import { Icon } from "@/components/Icon";
import { RunSummaryBar } from "@/components/RunSummaryBar";
import { StatusLabel } from "@/components/StatusLabel";
import {
  SAMPLE_TARGET,
  sampleEnvironments,
  sampleRun,
  sampleRuns,
  sampleScore,
} from "@/components/sample-data";

export const metadata = { title: "Overview" };

const LIVE_RUN_ID = sampleRuns[0].id;

export default function OverviewPage() {
  return (
    <main id="main-content" className="dashboard-page">
      <div className="page-header">
        <div>
          <span className="eyebrow">Target · {SAMPLE_TARGET.name}</span>
          <h1>Overview</h1>
          <p>
            {SAMPLE_TARGET.description} Baseline scored against all 55 WCAG 2.2 Level A and AA
            success criteria.
          </p>
        </div>
        <div className="page-action-row">
          <Link className="button primary" href={`/app/runs/${LIVE_RUN_ID}`}>
            Open live run
            <Icon name="arrow" size={15} />
          </Link>
        </div>
      </div>

      <h2 className="sr-only">Baseline score</h2>
      <dl className="score-grid">
        <div className="score-cell">
          <dt>Criteria failing</dt>
          <dd>{sampleScore.criteriaFailingBaseline}</dd>
          <span className="delta">of 55 in scope</span>
        </div>
        <div className="score-cell">
          <dt>Findings recorded</dt>
          <dd>{sampleScore.findingsTotal}</dd>
          <span className="delta">every one carries an artifact</span>
        </div>
        <div className="score-cell">
          <dt>Findings resolved</dt>
          <dd>{sampleScore.findingsResolved}</dd>
          <span className="delta">after the fix pass</span>
        </div>
        <div className="score-cell">
          <dt>Reported blocked</dt>
          <dd>{sampleScore.blocked}</dd>
          <span className="delta">1.2.4 and 3.3.4, with a stated reason</span>
        </div>
      </dl>

      <section className="section" aria-labelledby="live-run">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Running now</span>
            <h2 id="live-run">Parallel browser environments</h2>
            <p>
              Each environment drives one interaction path and reads the accessibility tree on both
              sides of it.
            </p>
          </div>
          <Link className="button secondary" href={`/app/runs/${LIVE_RUN_ID}`}>
            Run detail
            <Icon name="chevron-right" size={15} />
          </Link>
        </div>

        <RunSummaryBar run={sampleRun} />
        <div style={{ height: 14 }} />
        <EnvironmentGrid environments={sampleEnvironments} />
      </section>

      <section className="section" aria-labelledby="recent-runs">
        <div className="section-heading">
          <div>
            <span className="eyebrow">History</span>
            <h2 id="recent-runs">Recent runs</h2>
          </div>
          <Link className="button secondary" href="/app/runs">
            All runs
            <Icon name="chevron-right" size={15} />
          </Link>
        </div>

        <div className="record-list">
          {sampleRuns.slice(0, 3).map((run) => (
            <Link className="record-row" key={run.id} href={`/app/runs/${run.id}`}>
              <span className="record-main">
                <strong>{run.id}</strong>
                <small>
                  {run.target} · {run.findings} findings
                </small>
              </span>
              <StatusLabel value={run.status} />
              <Icon name="chevron-right" className="record-arrow" />
            </Link>
          ))}
        </div>
      </section>
    </main>
  );
}
