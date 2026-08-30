/**
 * Public demo mode, for the hosted deployment only.
 *
 * The hackathon deployment has to be usable by a judge who has no account and
 * no reason to hand a stranger's app the `repo` scope on their own GitHub. So
 * one environment variable turns the sign-in wall off, pins the target to
 * Clearway, and lets the Run button work.
 *
 * Every consequence of that is deliberate and confined here:
 *
 *   - It is **off unless `ACCESSIFIX_DEMO === '1'`**, which is set on the
 *     hosted deployment and nowhere else. A local checkout keeps real GitHub
 *     sign-in with no code path in common.
 *   - The visitor is treated as one fixed account, `ACCESSIFIX_DEMO_USER_ID`.
 *     That account owns the Clearway target and holds the GitHub token the
 *     audit reads the repository with, which is what makes a run possible at
 *     all without a sign-in.
 *   - Because every visitor shares that identity, a demo run is capped at the
 *     baseline audit in `app/api/runs/route.ts`. Nothing a visitor clicks can
 *     push a branch or open a pull request: the write half of the pipeline is
 *     never reached, so the approval gate cannot be answered by someone who
 *     does not own the repository.
 *
 * The cap is not only about consent. A serverless function is capped at 300
 * seconds on this plan, and a full crawl, audit, fix and verify does not fit;
 * the baseline does. Attempting the whole pipeline here would time out in the
 * middle and leave a half-written run, which is a worse demonstration than an
 * honest one that finishes.
 */

/** Whether this process is serving the public demo. */
export const DEMO_MODE = process.env.ACCESSIFIX_DEMO === '1';

/** The account a demo visitor acts as. Owns the target and the GitHub token. */
export const DEMO_USER_ID = process.env.ACCESSIFIX_DEMO_USER_ID ?? '';

/** The one target a demo visitor may run against. */
export const DEMO_TARGET_ID = process.env.ACCESSIFIX_DEMO_TARGET_ID ?? '';

/**
 * Demo mode with its identity actually configured.
 *
 * `DEMO_MODE` alone is not enough to act on: without a user id there is no
 * account to attribute a run to, and falling back to "some user" would be a
 * guess about whose repository is about to be read. Both must be present, or
 * the deployment behaves exactly as it does today and asks for a sign-in.
 */
export function demoReady(): boolean {
  return DEMO_MODE && DEMO_USER_ID.length > 0;
}

/** The identity every demo visitor shares. */
export function demoUser(): { id: string; name: string; email: null; image: null } {
  return { id: DEMO_USER_ID, name: 'Demo visitor', email: null, image: null };
}
