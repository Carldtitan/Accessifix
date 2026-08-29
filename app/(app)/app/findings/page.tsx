import { CriterionMatrix } from "@/components/CriterionMatrix";
import { FindingsTabs } from "@/components/FindingsTabs";
import { sampleCriterionRows, sampleFindings, sampleScore } from "@/components/sample-data";

export const metadata = { title: "Findings" };

export default function FindingsPage() {
  return (
    <main id="main-content" className="dashboard-page">
      <div className="page-header">
        <div>
          <span className="eyebrow">Findings ledger</span>
          <h1>Findings</h1>
          <p>
            One finding is one violation of one criterion on one page. No finding exists without a
            numbered success criterion and at least one artifact behind it.
          </p>
        </div>
      </div>

      <section className="section" style={{ marginTop: 0 }} aria-labelledby="findings-list">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Evidence</span>
            <h2 id="findings-list">Recorded findings</h2>
            <p>
              {sampleScore.findingsTotal} findings across {sampleScore.criteriaFailingBaseline}{" "}
              failing criteria. FLAG findings are routed to a human and are never auto-fixed.
            </p>
          </div>
        </div>
        <FindingsTabs findings={sampleFindings} />
      </section>

      <section className="section" aria-labelledby="findings-matrix">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Coverage</span>
            <h2 id="findings-matrix">Every criterion, baseline against final</h2>
            <p>
              AccessiFix does not claim a conformance level. It reports verdicts and counts, and it
              names the two criteria it cannot reach.
            </p>
          </div>
          <span className="section-count">{sampleCriterionRows.length}</span>
        </div>
        <CriterionMatrix rows={sampleCriterionRows} id="findings-criterion-matrix" />
      </section>

      <p className="muted" style={{ marginTop: 18, fontSize: 13 }}>
        Placeholder data. Findings will be read from the ledger.
      </p>
    </main>
  );
}
