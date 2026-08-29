import Link from "next/link";

import { CriterionMatrix } from "@/components/CriterionMatrix";
import { FindingsByCriterion } from "@/components/FindingsByCriterion";
import { FindingsTabs } from "@/components/FindingsTabs";
import { Icon } from "@/components/Icon";
import {
  formatUtcDate,
  groupByCriterion,
  scoreToMatrixRows,
  toFindingCards,
} from "@/components/run-data";

import { latestRun, requireSessionUser, runDetail } from "../../_data";

export const metadata = { title: "Findings" };
export const dynamic = "force-dynamic";

/**
 * The findings ledger for the most recent run.
 *
 * Both views are over the same rows: the tabs filter by severity, verdict and
 * status; the grouping below sorts by the criterion each finding cites. The
 * matrix underneath is the left join against the fixed list of 55, so a
 * criterion with nothing against it is reported rather than absent.
 */
export default async function FindingsPage() {
  const user = await requireSessionUser("/app/findings");
  const newest = await latestRun(user.id);
  const detail = newest ? await runDetail(newest.id, user.id) : null;

  if (!detail) {
    return (
      <main id="main-content" className="dashboard-page">
        <div className="page-header">
          <div>
            <span className="eyebrow">Findings ledger</span>
            <h1>Findings</h1>
            <p>
              One finding is one violation of one criterion on one page. No finding exists without
              a numbered success criterion behind it.
            </p>
          </div>
        </div>

        <div className="quiet-panel">
          <Icon name="activity" size={22} />
          <strong>No runs yet</strong>
          <span>
            The ledger is empty on this account. Start a run and every finding it records appears
            here.
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

  const cards = toFindingCards(detail.findings);
  const groups = groupByCriterion(detail.findings);
  const matrixRows = scoreToMatrixRows(detail.score, detail.finalScore);
  const score = detail.score;

  return (
    <main id="main-content" className="dashboard-page">
      <div className="page-header">
        <div>
          <span className="eyebrow">Findings ledger · {detail.target.repoFullName}</span>
          <h1>Findings</h1>
          <p>
            The most recent run, started {formatUtcDate(detail.run.startedAt ?? detail.run.createdAt)}.
            One finding is one violation of one criterion on one page.
          </p>
        </div>
        <div className="page-action-row">
          <Link className="button secondary" href={`/app/runs/${detail.run.id}`}>
            Open this run
            <Icon name="chevron-right" size={15} />
          </Link>
        </div>
      </div>

      <section className="section" style={{ marginTop: 0 }} aria-labelledby="findings-list">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Evidence</span>
            <h2 id="findings-list">Recorded findings</h2>
            <p>
              {score.totalFindings} finding{score.totalFindings === 1 ? "" : "s"} across{" "}
              {score.failingCriteria + score.flaggedCriteria} criteri
              {score.failingCriteria + score.flaggedCriteria === 1 ? "on" : "a"} with something
              against them. FLAG findings are routed to a human and are never auto-fixed.
            </p>
          </div>
          <span className="section-count">{cards.length}</span>
        </div>
        <FindingsTabs findings={cards} />
      </section>

      <section className="section" aria-labelledby="findings-grouped">
        <div className="section-heading">
          <div>
            <span className="eyebrow">By criterion</span>
            <h2 id="findings-grouped">Grouped by success criterion</h2>
            <p>Worst severity first, then by how many findings cite the criterion.</p>
          </div>
          <span className="section-count">{groups.length}</span>
        </div>
        <FindingsByCriterion
          groups={groups}
          headingLevel={3}
          emptyMessage="This run recorded no findings against any of the 55 criteria."
        />
      </section>

      <section className="section" aria-labelledby="findings-matrix">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Coverage</span>
            <h2 id="findings-matrix">Every criterion, baseline against final</h2>
            <p>
              AccessiFix does not claim a conformance level. It reports verdicts and counts, and it
              names the criteria it cannot reach.
            </p>
          </div>
          <span className="section-count">{matrixRows.length}</span>
        </div>
        <CriterionMatrix rows={matrixRows} id="findings-criterion-matrix" />
        <p className="muted" style={{ marginTop: 12, fontSize: 13 }}>
          {score.disclaimer}
        </p>
      </section>
    </main>
  );
}
