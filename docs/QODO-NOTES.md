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

---

## PR #4 — Task 8: Warm Control Room UI and run view

- **Link:** https://github.com/Carldtitan/Accessifix/pull/4
- **Qodo found:**
  - `High` — Approval never reaches harness. The card rendered its outcome banner on click without ever calling the server.
  - `Medium` — Account navigation leaves the mobile drawer open.
  - `Medium` — Findings total contradicts the list shown on the same page.
  - `Medium` — Tabs share the wrong panel; every tab pointed `aria-controls` at one shared panel.
  - `Medium` — Failed environment badge styled identically to live.
- **We changed:**
  - Rewrote `ApprovalCard` around a real submit state machine (`idle → submitting → settled | error`). The decision now POSTs to `/api/runs/{runId}/approve`; the outcome banner renders only after the call succeeds, and a failure surfaces the server's reason in a `role="alert"`. Given neither a `runId` nor a handler, the controls stay disabled and say so — the card can never mime a decision. The approval gate is A7 and the centrepiece of the demo; a button that fakes it is worse than no button at all.
  - Fixed the tabs properly against the WAI-ARIA pattern: one `role="tabpanel"` per tab, each tab's `aria-controls` naming its own panel and each panel's `aria-labelledby` naming its own tab, so the relationship resolves for inactive tabs too. Unselected panels stay in the DOM closed with `hidden`. Also needed a CSS fix — `.tabpanel { display: block }` would have silently defeated `hidden`. **This product detects exactly this class of ARIA wiring bug; shipping it would have been indefensible.**
  - Added `onClick={closeMenu}` to the account link, matching every other nav link.
  - Findings page now derives both numbers and labels the excerpt as a subset, so it no longer contradicts the criterion matrix beside it.
  - `failed` badge given its own deeper red ground plus a ring, so it differs from `live` by shape as well as hue rather than by colour alone. 8.5:1 composited, recorded in the contrast ledger.
- **We dismissed:** Nothing. All five were genuine.

---

## PR #7 — Task 4: deterministic TREE engine and the before/after score

- **Link:** https://github.com/Carldtitan/Accessifix/pull/7
- **Qodo found:** 8 bugs — disabled axe appears successful; link purpose ignores context (x2); input type assumes user data; zoom lock treated as proof of no reflow; unmeasured target spacing becomes a failure; clean pages disappear from the score; new-password fields expected the current-password token.
- **We changed:**
  - **The most serious one: `axeRan` was derived from "violations is not `undefined`"**, but `PageCapture` defaults that to `[]` and callers can pass `job: { axe: false }`. A page where axe never ran was indistinguishable from a page with no violations, so contrast and every other axe-dependent criterion **passed untested**. A false pass is worse than no result — it is the failure that makes an audit worthless. Execution is now believed only on an explicit flag, a supplied passes/incomplete set, or at least one violation actually returning.
  - 2.4.4 asks about link purpose *in context*, so context is now required: generic names fail only when captured context adds nothing beyond the name, and shared names fail only when name + context resolves to two different destinations. The AX-tree path no longer emits findings at all, since the tree carries no context.
  - A `type="email"` field no longer implies the address belongs to the *user* — an invitation form's recipient box is not a 1.3.5 failure. The field's own name/label establishes scope first.
  - A zoom lock no longer fails 1.4.10. It files 1.4.4 Resize Text, where W3C's ACT rule actually applies, and leaves reflow inconclusive pending a real 320px measurement. Needed a new `CheckResult.related` field for findings a check proves on someone else's behalf.
  - Unmeasured target spacing now means "the 2.5.8 exception was not tested", not "no clearance".
  - `pagesAudited` no longer derives from findings, which erased every page that passed cleanly — precisely the wrong pages to lose.
  - Password fields resolve to an accepted *set* — `new-password`, `current-password`, or both when ambiguous — so a correctly marked signup field is no longer failed for using the right token.
- **We dismissed:** One partial. Qodo grouped `type="password"` with email/tel/url as "assumes user data". We kept password decidable from its type: no form legitimately collects a third party's password, so scope is not genuinely in doubt. What *was* wrong is which of the two tokens it assumed, fixed separately. We also kept the fixed-viewport (`width=1024`) branch failing 1.4.10 — a viewport pinned above 320px means the content is never laid out at 320 CSS px, a direct mechanistic failure, unlike the zoom lock which W3C says can coexist with a passing 1.4.10.
