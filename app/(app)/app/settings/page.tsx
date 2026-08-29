import { Icon } from "@/components/Icon";

export const metadata = { title: "Settings" };

const roster: ReadonlyArray<{
  agent: string;
  owns: string;
  model: string;
  sandbox: string;
}> = [
  { agent: "TREE", owns: "16 criteria", model: "none — deterministic", sandbox: "none" },
  { agent: "VIS", owns: "27 criteria", model: "Anthropic, vision", sandbox: "none" },
  { agent: "ACT", owns: "26 criteria, all 12 state criteria", model: "Anthropic, fast", sandbox: "browser 2 CPU / 2 GB" },
  { agent: "PAGES", owns: "5 criteria", model: "Fireworks, cheap", sandbox: "none" },
  { agent: "MEDIA", owns: "4 criteria", model: "Anthropic, multimodal", sandbox: "none" },
  { agent: "CODE", owns: "3 criteria", model: "Fireworks, small", sandbox: "none" },
  { agent: "FIX", owns: "writes patches", model: "Anthropic, strong code", sandbox: "build 4 CPU / 8 GB" },
  { agent: "VERIFY", owns: "gates the pull request", model: "Fireworks + shell", sandbox: "build 4 CPU / 8 GB" },
];

export default function SettingsPage() {
  return (
    <main id="main-content" className="dashboard-page">
      <div className="page-header">
        <div>
          <span className="eyebrow">Configuration</span>
          <h1>Settings</h1>
          <p>How the run is routed, what it is allowed to spend, and what it is never allowed to do without asking.</p>
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
          <dl className="score-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
            <div className="cell">
              <dt>Signed in as</dt>
              <dd>Demo Reviewer</dd>
            </div>
            <div className="cell">
              <dt>GitHub scope</dt>
              <dd>repo</dd>
            </div>
            <div className="cell">
              <dt>Pull requests opened as</dt>
              <dd>you</dd>
            </div>
          </dl>
          <p className="muted" style={{ marginTop: 14, fontSize: 13 }}>
            Placeholder values. These come from the GitHub session once auth is wired in.
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
          <div className="criterion-scroll" role="region" aria-labelledby="roster-caption" tabIndex={0}>
            <table>
              <caption id="roster-caption">
                The agents dispatched during a run, what they own, and where they execute.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Agent</th>
                  <th scope="col">Owns</th>
                  <th scope="col">Model class</th>
                  <th scope="col">Sandbox</th>
                </tr>
              </thead>
              <tbody>
                {roster.map((row) => (
                  <tr key={row.agent}>
                    <th scope="row">{row.agent}</th>
                    <td className="col-name">{row.owns}</td>
                    <td>{row.model}</td>
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
            <p>Concurrency is budgeted from the configured cap, never from the core count reported inside a sandbox.</p>
          </div>
        </div>
        <div className="card">
          <dl className="score-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))" }}>
            <div className="cell">
              <dt>Max sandboxes</dt>
              <dd>8</dd>
            </div>
            <div className="cell">
              <dt>Page cap per crawl</dt>
              <dd>20</dd>
            </div>
            <div className="cell">
              <dt>Interaction depth</dt>
              <dd>1</dd>
            </div>
            <div className="cell">
              <dt>Build sandbox</dt>
              <dd>4 CPU / 8 GB</dd>
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
            <li>Every body-text colour pair is verified at 4.5:1 or better against its own surface.</li>
            <li>
              Every disclosure, tab and dialog updates its state attribute on change. The product
              detects that failure; it does not commit it.
            </li>
            <li>Focus is visible on every control and is never obscured by the sticky header.</li>
            <li>Live status changes go through a polite live region. Focus is never moved by an update.</li>
            <li>Motion honours <code>prefers-reduced-motion</code>; pinch zoom is never blocked.</li>
          </ul>
          <p className="muted" style={{ marginTop: 16, display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
            <Icon name="target" size={16} />
            AccessiFix will be pointed at its own deployed URL as a test target.
          </p>
        </div>
      </section>
    </main>
  );
}
