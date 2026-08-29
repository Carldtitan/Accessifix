import type { Metadata } from "next";
import Link from "next/link";
import { BrandMark, Icon } from "@/components/Icon";

export const metadata: Metadata = {
  title: { absolute: "AccessiFix — accessibility auditing that walks the state machine" },
};

export default function LandingPage() {
  return (
    <div className="landing-page">
      <header className="landing-header">
        <span className="landing-brand">
          <BrandMark size={33} />
          AccessiFix
        </span>
        <span className="eyebrow">WCAG 2.2 Level AA · 55 criteria</span>
      </header>

      <main id="main-content" className="landing-main">
        <div className="landing-copy">
          <h1>Every accessibility tool checks a page standing still. This one walks the state machine.</h1>
          <p className="landing-lede">
            Twelve of the 55 WCAG 2.2 Level AA criteria are only observable across a state transition.
            AccessiFix drives your interface through its transitions in parallel browsers, reads the
            accessibility tree on both sides of every interaction, writes the fix into your source,
            proves your own test suite still passes, and opens a pull request you review.
          </p>

          <div className="landing-actions">
            {/* Auth.js route handler, not an app route: a real navigation is required. */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a className="button primary large" href="/api/auth/signin">
              <Icon name="github" size={18} />
              Sign in with GitHub
            </a>
            <small>
              Read access to the repository, write access only through a pull request you approve.{" "}
              <Link href="/app">Look around the interface first</Link>.
            </small>
          </div>
        </div>

        <h2 className="sr-only">One worked example</h2>
        <ol className="landing-proof">
          <li className="proof-module">
            <span className="eyebrow">Example · Step 1</span>
            <h2>An interaction, not a snapshot</h2>
            <p>
              A control on the eligibility page opens a panel. AccessiFix snapshots the accessibility
              tree, clicks, and snapshots again.
            </p>
            <p>
              <code>Toggle · depth 1 · Chromium 1280x720</code>
            </p>
          </li>

          <li className="proof-module is-dark">
            <span className="eyebrow">Example · Step 2</span>
            <h2>The tree tells on it</h2>
            <p>
              <code>
                button &quot;What counts as a disability?&quot;
                <br />
                &nbsp;&nbsp;expanded: false — unchanged
                <br />
                group &quot;eligibility-panel&quot;
                <br />
                &nbsp;&nbsp;hidden: false — changed
              </code>
            </p>
            <p>The panel opened. The control still says it is collapsed. That is SC 4.1.2.</p>
          </li>

          <li className="proof-module">
            <span className="eyebrow">Example · Step 3</span>
            <h2>The fix, written into the source</h2>
            <p>
              One patch per file, each recording the findings it addresses. The repository is built in
              a sandbox and its own test suite has to pass before anything is proposed.
            </p>
            <p>
              <code>components/Accordion.tsx · covers SC 4.1.2</code>
            </p>
          </li>

          <li className="proof-module">
            <span className="eyebrow">Example · Step 4</span>
            <h2>You decide, then a pull request</h2>
            <p>
              The agent stops before every irreversible step and states what it intends to do, why, and
              what evidence supports it. Nothing is pushed until you approve.
            </p>
            <p>
              <code>148 tests passed · 3 criteria re-checked</code>
            </p>
          </li>
        </ol>
      </main>

      <footer className="landing-footer">
        AccessiFix reports findings against numbered success criteria and measures a before and after.
        It does not claim a conformance level, because no certifying body exists.
      </footer>
    </div>
  );
}
