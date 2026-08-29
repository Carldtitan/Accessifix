import { TargetsPanel } from "@/components/TargetsPanel";

import { listTargets, requireSessionUser } from "../../_data";

export const metadata = { title: "Targets" };
export const dynamic = "force-dynamic";

/**
 * Targets: a repository paired with its deployed URL, and the place a run is
 * started from.
 *
 * The list is a real query scoped to the signed-in user. The form and the
 * Start run button live in a client component because both are POSTs whose
 * refusals have to be shown with the reason the server gave.
 */
export default async function TargetsPage() {
  const user = await requireSessionUser("/app/targets");
  const targets = await listTargets(user.id);

  return (
    <main id="main-content" className="dashboard-page">
      <div className="page-header">
        <div>
          <span className="eyebrow">Connections</span>
          <h1>Targets</h1>
          <p>
            A target is a GitHub repository paired with its deployed URL. A run will not start
            unless the deployed URL answers with a 2xx response.
          </p>
        </div>
      </div>

      <TargetsPanel targets={targets} />
    </main>
  );
}
