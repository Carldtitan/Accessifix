import Link from "next/link";
import { Icon } from "@/components/Icon";
import { StatusLabel } from "@/components/StatusLabel";
import { sampleTargets } from "@/components/sample-data";

export const metadata = { title: "Targets" };

export default function TargetsPage() {
  return (
    <main id="main-content" className="dashboard-page">
      <div className="page-header">
        <div>
          <span className="eyebrow">Connections</span>
          <h1>Targets</h1>
          <p>
            A target is a GitHub repository paired with its deployed URL. A run will not start unless
            the deployed URL answers with a 2xx response.
          </p>
        </div>
      </div>

      <h2 className="sr-only">Connected targets</h2>
      <div className="record-list">
        {sampleTargets.map((target) => (
          <div className="record-row" key={target.id}>
            <span className="record-main">
              <strong>{target.name}</strong>
              <small>
                {target.repository} · {target.deployedUrl}
              </small>
            </span>
            <StatusLabel
              value={target.reachable ? "done" : "failed"}
              tone={target.reachable ? "done" : "blocked"}
            />
            {target.lastRun ? (
              <Link className="button secondary" href={`/app/runs/${target.lastRun}`}>
                Latest run
                <Icon name="chevron-right" size={15} />
              </Link>
            ) : (
              <span className="muted" style={{ fontSize: 13 }}>
                No runs yet
              </span>
            )}
          </div>
        ))}
      </div>

      <section className="section" aria-labelledby="add-target">
        <div className="section-heading">
          <div>
            <span className="eyebrow">New</span>
            <h2 id="add-target">Connect a target</h2>
            <p>
              Pull requests are opened with your own GitHub token, and only after you approve the
              handoff.
            </p>
          </div>
        </div>

        <form className="card" style={{ display: "grid", gap: 16, maxWidth: 620 }}>
          <div className="field">
            <label htmlFor="target-repo">Repository</label>
            <input
              id="target-repo"
              name="repository"
              type="text"
              placeholder="owner/repository"
              autoComplete="off"
              aria-describedby="target-repo-help"
            />
            <small id="target-repo-help">
              Requires the <code>repo</code> scope on your GitHub account.
            </small>
          </div>

          <div className="field">
            <label htmlFor="target-url">Deployed URL</label>
            <input
              id="target-url"
              name="deployedUrl"
              type="url"
              placeholder="https://example.com"
              autoComplete="url"
              aria-describedby="target-url-help"
            />
            <small id="target-url-help">
              Checked before the run starts. A non-2xx response stops the run with a stated reason.
            </small>
          </div>

          <div>
            <button className="button primary" type="submit" disabled>
              Connect target
              <Icon name="arrow" size={15} />
            </button>
            <p className="muted" style={{ marginTop: 10, fontSize: 12 }}>
              Placeholder form. Submission is wired up once the ledger and GitHub app are connected.
            </p>
          </div>
        </form>
      </section>
    </main>
  );
}
