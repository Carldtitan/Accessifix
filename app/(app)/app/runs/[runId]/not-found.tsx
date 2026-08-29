import Link from "next/link";

import { Icon } from "@/components/Icon";

/**
 * A run id that is not the signed-in user's.
 *
 * Deliberately the same page for "no such run" and "not your run": telling the
 * two apart would confirm that another account's run exists. A run id is a
 * UUID, not a capability.
 */
export default function RunNotFound() {
  return (
    <main id="main-content" className="dashboard-page">
      <div className="page-header">
        <div>
          <span className="eyebrow">Not found</span>
          <h1>No such run</h1>
          <p>
            This run does not exist, or it does not belong to the signed-in account. Those two
            answers are the same on purpose.
          </p>
        </div>
      </div>

      <p style={{ marginTop: 18 }}>
        <Link className="button primary" href="/app/runs">
          <Icon name="back" size={15} />
          All runs
        </Link>
      </p>
    </main>
  );
}
