import Link from "next/link";
import { AgentTimeline } from "@/components/AgentTimeline";
import { ApprovalCard } from "@/components/ApprovalCard";
import { CriterionMatrix } from "@/components/CriterionMatrix";
import { DiffStack } from "@/components/DiffCard";
import { EnvironmentGrid } from "@/components/EnvironmentGrid";
import { FindingCard } from "@/components/FindingCard";
import { Icon } from "@/components/Icon";
import { RunSummaryBar } from "@/components/RunSummaryBar";
import {
  sampleApproval,
  sampleCriterionRows,
  sampleEnvironments,
  sampleFindings,
  samplePatches,
  sampleRun,
  sampleTimeline,
} from "@/components/sample-data";

export const metadata = { title: "Run detail" };

/**
 * The run view. Requirement A11 lives here:
 * live parallel environments, a summary bar, proposed patches as diffs,
 * an attributed agent timeline, and the approval gate.
 *
 * PLACEHOLDER: everything on this page comes from components/sample-data.ts.
 */
export default async function RunDetailPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const stateFindings = sampleFindings.filter((finding) => finding.tree);

  return (
    <main id="main-content" className="dashboard-page">
      <div className="page-header">
        <div>
          <span className="eyebrow">Investigation</span>
          <h1>{runId}</h1>
        </div>
        <div className="page-action-row">
          <Link className="button secondary" href="/app/runs">
            <Icon name="back" size={15} />
            Runs
          </Link>
        </div>
      </div>

      <h2 className="sr-only">Run summary</h2>
      <RunSummaryBar run={sampleRun} />

      <section className="section" aria-labelledby="handoff">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Handoff</span>
            <h2 id="handoff">The agent is waiting for you</h2>
            <p>
              The run pauses before pushing a branch, before opening a pull request, and before any
              write-class tool call.
            </p>
          </div>
        </div>
        <ApprovalCard approval={sampleApproval} />
      </section>

      <section className="section" aria-labelledby="environments">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Live</span>
            <h2 id="environments">Browser environments</h2>
            <p>Interaction depth is one. Excess paths queue against the sandbox cap.</p>
          </div>
          <span className="section-count">{sampleEnvironments.length}</span>
        </div>
        <EnvironmentGrid environments={sampleEnvironments} />
      </section>

      <section className="section" aria-labelledby="patches">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Proposed</span>
            <h2 id="patches">Code changes</h2>
            <p>Patches are batched per source file and record the findings they address.</p>
          </div>
          <span className="section-count">{samplePatches.length}</span>
        </div>
        <DiffStack patches={samplePatches} />
      </section>

      <section className="section" aria-labelledby="state-findings">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Evidence</span>
            <h2 id="state-findings">State findings</h2>
            <p>
              Findings only observable across a state transition, each with the accessibility tree
              before and after the interaction.
            </p>
          </div>
          <span className="section-count">{stateFindings.length}</span>
        </div>
        <div style={{ display: "grid", gap: 12 }}>
          {stateFindings.map((finding) => (
            <FindingCard key={finding.id} finding={finding} />
          ))}
        </div>
      </section>

      <section className="section" aria-labelledby="matrix">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Score</span>
            <h2 id="matrix">Criterion matrix</h2>
            <p>Baseline against final, one row per criterion. Scope is never reduced to a subset.</p>
          </div>
          <span className="section-count">{sampleCriterionRows.length}</span>
        </div>
        <CriterionMatrix rows={sampleCriterionRows} id="run-criterion-matrix" />
      </section>

      <section className="section" aria-labelledby="timeline">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Chronology</span>
            <h2 id="timeline">Agent timeline</h2>
            <p>Every event names the agent that produced it and the harness capability behind it.</p>
          </div>
          <span className="section-count">{sampleTimeline.length}</span>
        </div>
        <AgentTimeline events={sampleTimeline} />
      </section>
    </main>
  );
}
