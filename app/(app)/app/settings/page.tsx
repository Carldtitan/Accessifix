import { GITHUB_SCOPE } from "@/auth";
import { Icon } from "@/components/Icon";
import { AUDIT_AGENTS, criteriaOwnedBy, stateCriteria } from "@/lib/db/criteria";
import { AGENT_ROSTER, isAgentName } from "@/lib/harness/agents";
import {
  BROWSER_RESOURCES,
  BUILD_RESOURCES,
  DEFAULT_MAX_CONCURRENT_SANDBOXES,
  INTERACTION_DEPTH,
  MAX_PAGES_PER_CRAWL,
} from "@/lib/sandbox/config";

import { requireSessionUser } from "../../_data";

export const metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

/* -------------------------------------------------------------------------- */
/* The roster, derived rather than transcribed                                */
/* -------------------------------------------------------------------------- */

interface RosterRow {
  agent: string;
  owns: string;
  model: string;
  sandbox: string;
}

const BROWSER_SANDBOX = `browser ${BROWSER_RESOURCES.cpu} CPU / ${BROWSER_RESOURCES.memory} GB`;
const BUILD_SANDBOX = `build ${BUILD_RESOURCES.cpu} CPU / ${BUILD_RESOURCES.memory} GB`;

/** Which lanes actually open a sandbox. The rest read what a lane captured. */
const SANDBOX_BY_AGENT: Record<string, string> = {
  ACT: BROWSER_SANDBOX,
  FIX: BUILD_SANDBOX,
  VERIFY: BUILD_SANDBOX,
};

function modelFor(agent: string): string {
  const key = agent.toLowerCase();
  // TREE is deterministic: axe-core and an accessibility tree snapshot, no model.
  if (!isAgentName(key)) return "none — deterministic";
  return AGENT_ROSTER[key].model;
}

function buildRoster(): RosterRow[] {
  const stateCount = stateCriteria().length;

  const auditRows: RosterRow[] = AUDIT_AGENTS.map((agent) => {
    const owned = criteriaOwnedBy(agent).length;
    return {
      agent,
      owns:
        agent === "ACT"
          ? `${owned} criteria, all ${stateCount} state criteria`
          : `${owned} criteri${owned === 1 ? "on" : "a"}`,
      model: modelFor(agent),
      sandbox: SANDBOX_BY_AGENT[agent] ?? "none",
    };
  });

  return [
    ...auditRows,
    { agent: "FIX", owns: "writes patches", model: modelFor("FIX"), sandbox: BUILD_SANDBOX },
    {
      agent: "VERIFY",
      owns: "gates the pull request",
      model: modelFor("VERIFY"),
      sandbox: BUILD_SANDBOX,
    },
  ];
}

/* -------------------------------------------------------------------------- */
/* Page                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Configuration, read from the code that enforces it.
 *
 * The roster, the criterion counts and the limits are all derived from
 * `lib/db/criteria.ts`, `lib/harness/agents.ts` and `lib/sandbox/config.ts`, so
 * this page cannot drift from what a run actually does. The account block is
 * the real GitHub session.
 */
export default async function SettingsPage() {
  const user = await requireSessionUser("/app/settings");
  const roster = buildRoster();

  return (
    <main id="main-content" className="dashboard-page">
      <div className="page-header">
        <div>
          <span className="eyebrow">Configuration</span>
          <h1>Settings</h1>
          <p>
            How the run is routed, what it is allowed to spend, and what it is never allowed to do
            without asking.
          </p>
        </div>
      </div>

      <section className="section" style={{ marginTop: 0 }} aria-labelledby="account">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Identity</span>
            <h2 id="account">Account</h2>
          </div>
        </div>
        <div className="card">
          <dl
            className="score-grid"
            style={{ gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}
          >
            <div className="cell">
              <dt>Signed in as</dt>
              <dd>{user.name}</dd>
            </div>
            <div className="cell">
              <dt>Email</dt>
              <dd>{user.email ?? "not shared by GitHub"}</dd>
            </div>
            <div className="cell">
              <dt>GitHub scope</dt>
              <dd>
                <code>{GITHUB_SCOPE}</code>
              </dd>
            </div>
            <div className="cell">
              <dt>Pull requests opened as</dt>
              <dd>you</dd>
            </div>
          </dl>
          <p className="muted" style={{ marginTop: 14, fontSize: 13 }}>
            The GitHub token is never placed on the session. It stays in the database and is read
            server-side only when a pull request is opened.
          </p>
        </div>
      </section>

      <section className="section" aria-labelledby="roster">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Routing</span>
            <h2 id="roster">Agent roster</h2>
            <p>
              Each criterion is routed by required capability, not by page, and each agent is a
              separate saved agent with its own model.
            </p>
          </div>
          <span className="section-count">{roster.length}</span>
        </div>

        <div className="criterion-matrix">
          <div
            className="criterion-scroll"
            role="region"
            aria-labelledby="roster-caption"
            tabIndex={0}
          >
            <table>
              <caption id="roster-caption">
                The agents dispatched during a run, what they own, and where they execute.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Agent</th>
                  <th scope="col">Owns</th>
                  <th scope="col">Model</th>
                  <th scope="col">Sandbox</th>
                </tr>
              </thead>
              <tbody>
                {roster.map((row) => (
                  <tr key={row.agent}>
                    <th scope="row">{row.agent}</th>
                    <td className="col-name">{row.owns}</td>
                    <td>
                      <code>{row.model}</code>
                    </td>
                    <td>{row.sandbox}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="section" aria-labelledby="limits">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Budget</span>
            <h2 id="limits">Limits</h2>
            <p>
              Concurrency is budgeted from the configured cap, never from the core count reported
              inside a sandbox.
            </p>
          </div>
        </div>
        <div className="card">
          <dl
            className="score-grid"
            style={{ gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))" }}
          >
            <div className="cell">
              <dt>Max sandboxes</dt>
              <dd>{DEFAULT_MAX_CONCURRENT_SANDBOXES}</dd>
            </div>
            <div className="cell">
              <dt>Page cap per crawl</dt>
              <dd>{MAX_PAGES_PER_CRAWL}</dd>
            </div>
            <div className="cell">
              <dt>Interaction depth</dt>
              <dd>{INTERACTION_DEPTH}</dd>
            </div>
            <div className="cell">
              <dt>Build sandbox</dt>
              <dd>
                {BUILD_RESOURCES.cpu} CPU / {BUILD_RESOURCES.memory} GB
              </dd>
            </div>
          </dl>
        </div>
      </section>

      <section className="section" aria-labelledby="own-audit">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Rule 7</span>
            <h2 id="own-audit">This interface passes its own audit</h2>
          </div>
        </div>
        <div className="card">
          <ul className="plain-list">
            <li>
              Every body-text colour pair is verified at 4.5:1 or better against its own surface.
            </li>
            <li>
              Every disclosure, tab and dialog updates its state attribute on change. The product
              detects that failure; it does not commit it.
            </li>
            <li>Focus is visible on every control and is never obscured by the sticky header.</li>
            <li>
              Live status changes go through a polite live region. Focus is never moved by an
              update.
            </li>
            <li>
              Motion honours <code>prefers-reduced-motion</code>; pinch zoom is never blocked.
            </li>
          </ul>
          <p
            className="muted"
            style={{
              marginTop: 16,
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 13,
            }}
          >
            <Icon name="target" size={16} />
            AccessiFix will be pointed at its own deployed URL as a test target.
          </p>
        </div>
      </section>
    </main>
  );
}
