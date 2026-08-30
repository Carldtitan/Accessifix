import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { auth } from "@/auth";
import { BrandMark, Icon } from "@/components/Icon";
import { demoReady } from "@/lib/demo";

export const metadata: Metadata = {
  title: "AccessiFix",
  description:
    "Finds the accessibility bugs that break your site for blind users, fixes them, and opens a pull request.",
};

/**
 * The four cards are the actual workflow, in order, in the user's words.
 * One short sentence each. A visitor decides in about four seconds.
 */
interface Step {
  readonly n: string;
  readonly title: string;
  readonly body: string;
}

const STEPS: readonly Step[] = [
  {
    n: "1",
    title: "Connect your repo",
    body: "Point it at your GitHub repository and your live site.",
  },
  {
    n: "2",
    title: "It clicks through everything",
    body: "40 real browsers at once, checking all 55 WCAG rules.",
  },
  {
    n: "3",
    title: "It writes the fix",
    body: "Patches your code, then runs your own tests to prove nothing broke.",
  },
  {
    n: "4",
    title: "You approve the PR",
    body: "Nothing reaches your repository until you say yes.",
  },
];

export default async function LandingPage() {
  /*
   * A signed-in visitor asking for the landing page wants their workspace, not
   * a pitch and a sign-in button they have already used.
   */
  // The hosted demo has no sign-in to offer, so the pitch page would be a
  // dead end with a button that asks for a GitHub scope nobody needs to grant.
  if (demoReady()) redirect("/app");

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
        <div className="landing-hero">
          <div className="landing-copy">
            <h1>
              Find and fix your
              <br />
              <em>accessibility bugs.</em>
            </h1>
            <p className="landing-lede">
              Connect your repo. AccessiFix clicks through your site in 40 browsers, finds
              what is broken for disabled users, and opens a pull request with the fix.
            </p>

            {/* Auth.js route handler, not an app route: a real navigation is required. */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a className="button primary large" href="/api/auth/signin?callbackUrl=%2Fapp">
              <Icon name="github" size={18} />
              Sign in with GitHub
            </a>
          </div>

          {/*
            The real finding from a live SSDI benefits application. Not a mockup:
            the menu grew by 98 nodes while the button kept reporting "closed".
          */}
          <figure className="landing-evidence">
            <figcaption>Found on a real benefits site</figcaption>
            <div className="evidence-row">
              <span>menu opened</span>
              <strong>98 new items</strong>
            </div>
            <div className="evidence-row is-bad">
              <span>button still says</span>
              <strong>closed</strong>
            </div>
            <p>WCAG 4.1.2 · Name, Role, Value</p>
          </figure>
        </div>

        <ol className="landing-proof">
          {STEPS.map((step) => (
            <li key={step.n} className="proof-module">
              <span className="proof-n" aria-hidden="true">
                {step.n}
              </span>
              <h2>{step.title}</h2>
              <p>{step.body}</p>
            </li>
          ))}
        </ol>
      </main>

      <footer className="landing-footer">
        Every finding cites a numbered WCAG criterion and carries evidence.
      </footer>
    </div>
  );
}
