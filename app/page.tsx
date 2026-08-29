import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { auth } from "@/auth";
import { BrandMark, Icon } from "@/components/Icon";

export const metadata: Metadata = {
  title: "AccessiFix",
  description:
    "Finds accessibility bugs that only appear when you click. Fixes them and opens a pull request.",
};

export default async function LandingPage() {
  /*
   * A signed-in visitor asking for the landing page wants their workspace, not
   * a pitch and a sign-in button they have already used.
   */
  const session = await auth();
  if (session?.user) redirect("/app");

  return (
    <div className="landing-page">
      <header className="landing-header">
        <span className="landing-brand">
          <BrandMark size={31} />
          AccessiFix
        </span>
        <span className="eyebrow">WCAG 2.2 AA</span>
      </header>

      <main id="main-content" className="landing-main">
        <div className="landing-copy">
          <h1>Most accessibility bugs only appear after you click.</h1>
          <p className="landing-lede">
            Scanners look at a page sitting still. AccessiFix clicks things, watches what
            the screen reader is told, and catches the lies.
          </p>

          {/* Auth.js route handler, not an app route: a real navigation is required. */}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
          <a className="button primary large" href="/api/auth/signin?callbackUrl=%2Fapp">
            <Icon name="github" size={18} />
            Sign in with GitHub
          </a>
        </div>

        <ol className="landing-proof">
          <li className="proof-module">
            <span className="eyebrow">1</span>
            <h2>It clicks</h2>
            <p>Opens the menu in a real browser and reads the page before and after.</p>
          </li>

          <li className="proof-module is-dark">
            <span className="eyebrow">2</span>
            <h2>It catches the lie</h2>
            <p>
              <code>
                menu opened: 98 new items
                <br />
                button still says: closed
              </code>
            </p>
            <p>A blind user is told nothing happened. Found on a real benefits site.</p>
          </li>

          <li className="proof-module">
            <span className="eyebrow">3</span>
            <h2>It fixes it</h2>
            <p>Writes the patch, runs your tests, opens a pull request.</p>
          </li>

          <li className="proof-module">
            <span className="eyebrow">4</span>
            <h2>You approve</h2>
            <p>Nothing is pushed until you say so.</p>
          </li>
        </ol>
      </main>

      <footer className="landing-footer">
        Reports real WCAG criteria with evidence. Never claims a conformance level.
      </footer>
    </div>
  );
}
