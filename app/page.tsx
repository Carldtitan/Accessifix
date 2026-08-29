import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { auth } from "@/auth";
import { BrandMark, Icon } from "@/components/Icon";

export const metadata: Metadata = {
  title: "AccessiFix",
  description:
    "Spins up a fleet of real browsers, clicks everything, and finds the accessibility bugs scanners cannot see.",
};

/**
 * Four cards, one line each.
 *
 * `code` is the only place a card carries evidence, and only card 2 has it:
 * the real Clearway finding, unedited. Everything else is one short sentence,
 * because a visitor decides in about four seconds and prose does not help.
 */
interface Step {
  readonly n: string;
  readonly title: string;
  readonly body: string;
  /** Only card 3 carries evidence. */
  readonly code?: readonly [string, string];
  readonly dark?: boolean;
}

const STEPS: readonly Step[] = [
  {
    n: "1",
    title: "Spins up 40 browsers",
    body: "One real Chromium per interaction, all at once.",
  },
  {
    n: "2",
    title: "Clicks everything",
    body: "Reads what a screen reader is told, before and after.",
  },
  {
    n: "3",
    title: "Catches the lie",
    code: ["menu opened: 98 new items", "button still says: closed"],
    body: "A blind user is told nothing happened.",
    dark: true,
  },
  {
    n: "4",
    title: "Fixes it, asks you",
    body: "Patches your code, runs your tests, opens a PR.",
  },
];

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
        <span className="eyebrow">WCAG 2.2 AA · 55 criteria</span>
      </header>

      <main id="main-content" className="landing-main">
        <div className="landing-copy">
          <h1>
            Scanners read one still page.
            <br />
            <em>We click everything.</em>
          </h1>
          <p className="landing-lede">
            Most accessibility bugs only show up after an interaction. AccessiFix runs a
            fleet of real browsers, drives your interface, and fixes what it finds.
          </p>

          {/* Auth.js route handler, not an app route: a real navigation is required. */}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
          <a className="button primary large" href="/api/auth/signin?callbackUrl=%2Fapp">
            <Icon name="github" size={18} />
            Sign in with GitHub
          </a>
        </div>

        <ol className="landing-proof">
          {STEPS.map((step) => (
            <li key={step.n} className={`proof-module${step.dark ? " is-dark" : ""}`}>
              <span className="proof-n" aria-hidden="true">
                {step.n}
              </span>
              <h2>{step.title}</h2>
              {step.code ? (
                <p>
                  <code>
                    {step.code[0]}
                    <br />
                    {step.code[1]}
                  </code>
                </p>
              ) : null}
              <p>{step.body}</p>
            </li>
          ))}
        </ol>
      </main>

      <footer className="landing-footer">
        Every finding cites a numbered WCAG criterion and carries evidence. Never claims a
        conformance level.
      </footer>
    </div>
  );
}
