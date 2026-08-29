import Link from "next/link";
import { notFound } from "next/navigation";

import { Icon } from "@/components/Icon";
import { RunLiveView } from "@/components/RunLiveView";
import { formatUtcDate } from "@/components/run-data";

import { requireSessionUser, runDetail } from "../../../_data";

export const metadata = { title: "Run detail" };
export const dynamic = "force-dynamic";

/**
 * The run view. Requirement A11 lives here.
 *
 * The server does the first paint from the ledger so the page is complete
 * before any JavaScript runs; `RunLiveView` then subscribes to
 * `/api/runs/{id}/events` and keeps it current without a refresh.
 *
 * Ownership: `runDetail` joins through `targets.user_id`, and a run that is not
 * the signed-in user's is a 404 — never a 403, which would confirm it exists.
 *
 * Next 16: `params` is a Promise.
 */
export default async function RunDetailPage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const { runId } = await params;
  const user = await requireSessionUser(`/app/runs/${runId}`);
  const detail = await runDetail(runId, user.id);

  if (!detail) notFound();

  return (
    <main id="main-content" className="dashboard-page">
      <div className="page-header">
        <div>
          <span className="eyebrow">Investigation · {detail.target.repoFullName}</span>
          <h1>{detail.target.deployedUrl}</h1>
          <p>
            Started {formatUtcDate(detail.run.startedAt ?? detail.run.createdAt)}
            {detail.run.completedAt
              ? `, finished ${formatUtcDate(detail.run.completedAt)}`
              : ""}
            . Run <code>{detail.run.id}</code>.
          </p>
        </div>
        <div className="page-action-row">
          <Link className="button secondary" href="/app/runs">
            <Icon name="back" size={15} />
            Runs
          </Link>
        </div>
      </div>

      <RunLiveView
        run={detail.run}
        target={detail.target}
        score={detail.score}
        finalScore={detail.finalScore}
        findings={detail.findings}
        events={detail.events}
        jobs={detail.jobs}
        patches={detail.patches}
        pendingHandoffs={detail.pendingHandoffs}
        pageCount={detail.pages.length}
        frames={detail.frames}
        {...(detail.activeModel ? { activeModel: detail.activeModel } : {})}
      />
    </main>
  );
}
