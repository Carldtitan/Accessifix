# Qodo Review Notes

Raw material for the `## Qodo Code Review Evidence` section of the README
(hackathon Rule 10). One entry per pull request, written the same day the
review landed — never reconstructed from memory afterwards.

Every substantive change reached `main` through a pull request that Qodo
reviewed. `main` is branch-protected with `enforce_admins: true`, so direct
pushes are rejected for everyone including the repository owner.

---

## PR #2 — Task 2: findings ledger and GitHub auth

- **Link:** https://github.com/Carldtitan/Accessifix/pull/2
- **Qodo found:**
  - `High` — Repo-scoped GitHub OAuth token copied onto the session object, which is serialised to the browser.
  - `High` — Persisted token never refreshes; `linkAccount` fires only on account creation, so re-sign-ins keep a stale or revoked token.
  - `High` — `findings.phase` can diverge from its parent run's phase.
  - `Medium` — Any text is accepted as a `criterion` value.
  - `Medium` — Cross-run `runId`/`pageId` linking is possible without a composite key.
  - Two high-level notes: use the official Auth.js Drizzle adapter; commit the generated SQL migrations.
- **We changed:**
  - Token removed from the session **and** from the JWT. `getGitHubAccessToken()` now reads it from the `accounts` row server-side only. A `repo`-scoped token reachable from the browser is full account access, not merely a leak.
  - Added a `signIn` callback that updates `access_token`, `expires_at`, `refresh_token`, `scope` and `token_type` on every sign-in. Without it, a re-sign-in after a revoke leaves a dead token and PR creation fails with a confusing 401 much later.
  - Added `uniqueIndex('runs_id_phase_key')` on `runs(id, phase)` and a composite FK from `findings(run_id, phase)`. Phase stays denormalised so the A8 delta is one grouped query, but it can no longer drift. A silent phase drift would corrupt the before/after headline invisibly.
  - Added `check('findings_criterion_is_wcag')` constraining `criterion` to the 55 real WCAG 2.2 A/AA ids, generated from `criteria.ts` so the constraint and the seed cannot disagree. Non-negotiable rule 3 is now enforced by the database rather than by convention.
  - Switched to the official `@auth/drizzle-adapter`; committed `0000_init.sql` with all four constraints.
- **We dismissed:**
  - The `Medium` on cross-run `runId`/`pageId` linking. Reason given in-thread: no write path constructs findings across runs — a single dispatcher owns insertion. Accepting the risk rather than adding a composite key.

---

## PR #3 — Task 3: Daytona sandboxes and the accessibility-tree browser layer

- **Link:** https://github.com/Carldtitan/Accessifix/pull/3
- **Qodo found:** No bugs. The review weighed three architecture options for the sandbox/browser split and agreed with the one implemented.
- **We changed:** Nothing required.
- **We dismissed:** Nothing.
