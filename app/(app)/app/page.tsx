import Link from "next/link";

import { EnvironmentGrid } from "@/components/EnvironmentGrid";
import { Icon } from "@/components/Icon";
import { RunSummaryBar } from "@/components/RunSummaryBar";
import { StatusLabel } from "@/components/StatusLabel";
import {
  findingsByPage,
  formatUtcDate,
  jobsToEnvironments,
  runStatusLabel,
  toRunSummary,
} from "@/components/run-data";

import { overview, requireSessionUser } from "../_data";

export const metadata = { title: "Overview" };
export const dynamic = "force-dynamic";

/**
 * The overview. Every number here is a query over the findings ledger; nothing
 * is a placeholder. A user with no targets is told that, not shown a spinner.
 */
export default async function OverviewPage() {
  const user = await requireSessionUser("/app");
  const { targets, runs, latest } = await overview(user.id);

  /* ---------------------------------------------------------------------- */
  /* Nothing connected yet                                                  */
  /* ---------------------------------------------------------------------- */

  if (targets.length === 0) {
    return (
      <main id="main-content" className="dashboard-page">
        <div className="page-header">
          <div>
            <span className="eyebrow">Getting started</span>
            <h1>Overview</h1>
            <p>
              AccessiFix audits a deployed site against all 55 WCAG 2.2 Level A and AA success
              criteria, writes the fixes it is confident in, and hands the rest to you.
            </p>
          </div>
        </div>

        <div className="quiet-panel">
          <Icon name="target" size={22} />
          <strong>No targets connected</strong>
          <span>
            Connect a repository and its deployed URL, then start a run. Nothing can be scored
            until one exists.
          </span>
        </div>

        <p style={{ marginTop: 18 }}>
          <Link className="button primary" href="/app/targets">
            Connect a target
            <Icon name="arrow" size={15} />
          </Link>
        </p>
      </main>
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Connected, but nothing has run                                         */
  /* ---------------------------------------------------------------------- */

  if (!latest) {
    return (
      <main id="main-content" className="dashboard-page">
        <div className="page-header">
          <div>
            <span className="eyebrow">Target · {targets[0].repoFullName}</span>
            <h1>Overview</h1>
            <p>{targets[0].deployedUrl}</p>
          </div>
          <div className="page-action-row">
            <Link className="button primary" href="/app/targets">
              Start a run
              <Icon name="play" size={15} />
            </Link>
          </div>
        </div>

        <div className="quiet-panel">
          <Icon name="activity" size={22} />
          <strong>No runs yet</strong>
          <span>
            {targets.length} target{targets.length === 1 ? "" : "s"} connected and nothing audited.
            Start a run from the targets page and this fills in as it works.
          </span>
        </div>
      </main>
    );
  }

  /* ---------------------------------------------------------------------- */
  /* A real run exists                                                      */
  /* ---------------------------------------------------------------------- */

  const score = latest.score;
  const environments = jobsToEnvironments(latest.jobs, findingsByPage(latest.findings));
  const summary = toRunSummary(
    latest.run,
    latest.activeModel ? { activeModel: latest.activeModel } : {},
  );

  return (
    <main id="main-content" className="dashboard-page">
      <div className="page-header">
        <div>
          <span className="eyebrow">Target · {latest.target.repoFullName}</span>
          <h1>Overview</h1>
          <p>
            {latest.target.deployedUrl}. Scored against all 55 WCAG 2.2 Level A and AA success
            criteria.
          </p>
        </div>
        <div className="page-action-row">
          <Link className="button primary" href={`/app/runs/${latest.run.id}`}>
            Open latest run
            <Icon name="arrow" size={15} />
          </Link>
        </div>
      </div>

      <h2 className="sr-only">Latest score</h2>
      <dl className="score-grid">
        <div className="score-cell">
          <dt>Criteria failing</dt>
          <dd>{score.failingCriteria}</dd>
          <span className="delta">of {score.totalCriteria} in scope</span>
        </div>
        <div className="score-cell">
          <dt>Findings recorded</dt>
          <dd>{score.totalFindings}</dd>
          <span className="delta">{score.openFindings} still open</span>
        </div>
        <div className="score-cell">
          <dt>Routed to a human</dt>
          <dd>{score.flaggedCriteria}</dd>
          <span className="delta">FLAG criteria, never auto-fixed</span>
        </div>
        <div className="score-cell">
          <dt>Reported blocked</dt>
          <dd>{score.blockedCriteria}</dd>
          <span className="delta">out of reach, with a stated reason</span>
        </div>
      </dl>

      <p className="muted" style={{ marginTop: 12, fontSize: 13 }}>
        {score.disclaimer}
      </p>

      <section className="section" aria-labelledby="live-run">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Latest run</span>
            <h2 id="live-run">Parallel browser environments</h2>
            <p>
              Each environment drives one unit of work and reads the accessibility tree on both
              sides of it.
            </p>
          </div>
          <Link className="button secondary" href={`/app/runs/${latest.run.id}`}>
            Run detail
            <Icon name="chevron-right" size={15} />
          </Link>
        </div>

        <RunSummaryBar run={summary} />
        <div style={{ height: 14 }} />
        <EnvironmentGrid
          environments={environments}
          emptyMessage="This run recorded no environments. Open the run for its full timeline."
        />
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
          {runs.slice(0, 3).map((run) => (
            <Link className="record-row" key={run.id} href={`/app/runs/${run.id}`}>
              <span className="record-main">
                <strong>{run.repoFullName}</strong>
                <small>
                  {run.findingCount} finding{run.findingCount === 1 ? "" : "s"} · started{" "}
                  {formatUtcDate(run.startedAt ?? run.createdAt)}
                  {run.failureReason ? ` · ${run.failureReason}` : ""}
                </small>
              </span>
              <StatusLabel value={runStatusLabel(run.status)} />
              <Icon name="chevron-right" className="record-arrow" />
            </Link>
          ))}
        </div>
      </section>
    </main>
  );
}
