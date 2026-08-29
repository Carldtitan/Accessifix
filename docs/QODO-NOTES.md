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

## PR #5 — Task 6: TrueForge harness client and the seven-agent roster

- **Link:** https://github.com/Carldtitan/Accessifix/pull/5
- **Qodo found:**
  - `Reliability` — Timeout ends before body. The request timer was cleared when headers arrived.
  - `Correctness` — Fallback runtime config diverges from the primary agent.
  - `Correctness` — Lane verdict policy unenforced; MEDIA and CODE could emit `DECIDE`.
  - `Correctness` — Pre-aborted `AbortSignal`s ignored.
  - `Correctness` — CRLF SSE events lost.
  - `Correctness` — Provider race clobbers a concurrent winner's configuration.
  - `Correctness` — Unknown criteria pass validation on patch, skipped and recheck paths.
- **We changed:**
  - Extracted a `RequestGuard` that lives until `response.text()` completes, so a server that sends headers then stalls now raises a timeout instead of hanging. Also removed a `.catch(() => "")` that was turning body-read failures into confusing schema errors.
  - **The fallback is now built from the saved agent's own manifest read back from the server, with only the model swapped.** Qodo's suggested plumbing alone still left the bug when a caller omits the options, because `buildAgentSpec` reads an absent `sandboxAvailable` as enabled. **Live evidence this mattered: on our instance `sandbox.enabled` is false, and the pre-fix fallback was rejected outright with `422: sandbox is enabled but no sandbox provider is configured`. ACT, FIX and VERIFY had no working fallback at all.** The fixed one runs.
  - Lane verdict sets are now enforced in **both** Zod and the emitted JSON Schema. MEDIA and CODE publish `enum: ["FLAG"]`. MEDIA's output is opinion — it judges whether a transcript conveys what a video shows — and must never be a decision. Verified live: the narrowed contract was accepted by the provider, and when pushed with "you are very confident this is a clear failure" the model returned three findings, all `FLAG`.
  - `guardRequest` checks `callerSignal.aborted` up front, since `abort` is never replayed to late listeners. Verified: the request never reaches the server.
  - SSE parser normalises `\r\n` and `\r` to `\n` per spec, holds back a trailing CR so a boundary split across chunks is not mis-framed, and flushes an unterminated final frame. Verified live against `/subscribe`.
  - Provider 409 now re-lists, finds the winner, and merges into *their* manifest so `base_url` and hand-tuned fields survive. If the winner already has every roster model it returns `unchanged` with no PUT at all.
  - A shared `CriterionIdSchema` pins the criterion enum to the 55 real ids across patch, skipped and recheck. `1.9.9` and `9.9.9` are rejected everywhere.
- **We dismissed:** Nothing. All seven were genuine.
- **Partial, stated rather than hidden:** the per-criterion "a BLOCKED-class criterion may never be `DECIDE`" rule cannot be expressed in a flat JSON Schema enum — it needs `anyOf` branching, which strict-mode providers handle inconsistently. Zod enforces it hard and the `verdict` description states it. The lane-level rule Qodo actually asked for is fully enforced in both.
