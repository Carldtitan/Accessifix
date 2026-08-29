# AccessiFix

An accessibility code-review agent. Connect a GitHub repository and its deployed URL. AccessiFix audits the live site against all 55 WCAG 2.2 Level AA success criteria, writes fixes into the source, proves the fixes did not break the application, and opens a pull request behind a human approval gate.

Built on [TrueForge](https://trueforge.dev) for the Agent Harness Hackathon.

## The differentiator

Every other accessibility tool inspects a page in **one state**. AccessiFix drives the interface through its **state transitions** and diffs the accessibility tree on both sides of every interaction. **Twelve of the 55 criteria are only observable that way** — a control that changes the page but never changes its own `aria-expanded` is invisible to a single-state scan, and is a 4.1.2 failure to a screen reader user.

It also runs a second comparison the tree cannot do alone: what the accessibility tree *exposes* against what a vision model can *see*. Anything visible in the screenshot but absent from the tree is a div-button — a control assistive technology cannot reach. There is nothing to enumerate and nothing to diff, so a tree-only tool can never produce that finding.

## Verified run

Full pipeline, end to end, against `https://clearway-kappa.vercel.app` (an SSDI benefits application — a site disabled people must use to claim disability benefits):

**164 seconds** — crawl → TREE → VIS → vision candidates → path enumeration → ACT → score.

**6 real findings:**

| Criterion | Count | Detail |
| --- | --- | --- |
| 1.4.11 Non-text Contrast | 3 | Language card buttons, measured **1.4:1** border against a 3:1 requirement |
| 4.1.2 Name, Role, Value | 3 | Controls whose exposed name, role or state does not match their behaviour |

## What this does not claim

- **No conformance level, ever.** `conformanceClaim` is the literal type `null` in `lib/audit/types.ts`, so claiming one is uncompilable — not a policy, a compile error. There is no certifying body for WCAG. A tool that reports "you are now AA" is lying.
- **Two criteria are reported `BLOCKED`, never as passing.** 1.2.4 Captions (Live) — cannot audit a stream that is not running. 3.3.4 Error Prevention — would require completing a real legal or financial transaction. Each carries its reason in the report.
- **A false pass is worse than no result.** Several classes of silent false-pass were caught in code review and closed (see below); the audit now believes a check ran only on explicit evidence that it ran.
- The verified 164-second run was executed with TrueForge running locally (WSL, port 8790 — v0.1.4 crashes on Windows). **A hosted, always-on deployment has not been load-tested.** The FIX → VERIFY → PR half of the pipeline is implemented and approval-gated, but has fewer end-to-end runs behind it than the audit half.

## Architecture

Next.js App Router application, Postgres findings ledger, seven saved TrueForge agents, Daytona sandboxes.

**The ledger is the product.** One table. The score is a group-by over `criterion`; the before/after delta is a diff between rows where `phase = 'baseline'` and rows where `phase = 'final'`. Every view is a query over it. Agents never write to the database — the application validates and persists every claim.

### Agent roster

Seven saved TrueForge agents, each pinned to its own model. TrueForge subagents inherit their parent's model, so a single agent cannot fan out across seven; routing therefore happens one level up, in application code.

| Agent | Owns | Model class | Sandbox |
| --- | --- | --- | --- |
| TREE *(library, not an agent)* | 16 criteria, deterministic | none — `axe-core` + CDP `Accessibility.getFullAXTree` | none |
| VIS | 27 criteria | Anthropic, vision | none — reads screenshots |
| ACT | 26 criteria, **all 12 state-dependent** | Anthropic, fast | browser 2 CPU / 2 GB, many |
| PAGES | 5 criteria (comparative — waits for the crawl) | Fireworks, cheap | none |
| MEDIA | 4 criteria (own queue, never blocks a browser) | Anthropic, multimodal | none |
| CODE | 3 criteria (2.5.1, 2.5.4, 2.5.7 — they live only in event handlers) | Fireworks, small | none |
| FIX | writes patches | Anthropic, strong code | build 4 CPU / 8 GB |
| VERIFY | gates the PR | Fireworks + shell | build 4 CPU / 8 GB |

TREE runs first, on every page, with no sandbox and no model — cheap gates eliminate most findings before a model is called. VIS and ACT then run in parallel.

### Harness utilisation

- **15 git-backed Skill packs** in `skills/`, covering **53 of the 55 criteria** — the two uncovered are exactly the two `BLOCKED` ones. Registered on TrueForge as `git` skill manifests and mounted per lane, loaded by **progressive disclosure**: an agent holds a skill's name and one-line description, and pulls the body on demand. No agent ever carries the text of all 55 criteria.
- **0 out-of-lane violations, enforced at module load.** `assertSkillsWithinLane()` in `lib/harness/agents.ts` throws at boot if any agent mounts a skill covering a criterion it does not own; `lanePolicy` does the same for the roster against the criteria table. A disagreement would mean findings that pass the harness schema and are then discarded by the ledger — which reads on the report as a clean page — so it fails the boot instead.
- **Per-lane narrowed response schemas.** Each agent's `response_format` is narrowed to its own criteria. VIS *physically cannot emit* a criterion outside its lane; it is not asked to behave, it is unable to misbehave.
- **Approval gate.** The run pauses before pushing a branch, before opening a pull request, and before any write-class tool call. The handoff card states the intent, the reason, and the supporting evidence — a written explanation, not a raw tool payload. The session survives a page reload and an application restart.
- **Resumable.** Every job row stores its TrueForge session id, so a restarted run resumes from the ledger rather than starting over.
- **Evidence or it did not happen.** Every finding carries an artifact — screenshot, accessibility-tree excerpt, or source location — written to the sandbox and downloaded, never held in model context.

## Setup

Requires Node 20+, a Postgres database (Supabase session pooler, port 5432), and TrueForge running locally.

```bash
npm install
cp .env.example .env.local   # fill AUTH_GITHUB_ID, AUTH_GITHUB_SECRET, DATABASE_URL, ANTHROPIC_API_KEY, DAYTONA_API_KEY
npm run db:push              # push the Drizzle schema
npm run db:seed              # seed the 55 criteria
npm run agents:init          # create the seven saved TrueForge agents and register the Skills
npm run dev
```

GitHub OAuth app callback: `http://localhost:3000/api/auth/callback/github`, `repo` scope.

TrueForge runs standalone on `localhost:8790` with auth disabled locally, so `TRUEFORGE_API_KEY` stays empty. Run it under WSL — v0.1.4 crashes on Windows on an ESM drive-letter bug — and install it globally (`npm i -g @truefoundry/trueforge`); `npx` leaves `better-sqlite3` unbuilt. `FIREWORKS_API_KEY` is optional; leave it blank to run every lane on Anthropic.

## Qodo Code Review Evidence

Every substantive change reached `main` through a pull request that Qodo Merge reviewed. `main` is branch-protected with `enforce_admins: true`, so direct pushes are rejected for everyone including the repository owner.

**Representative pull request: [#2 — findings ledger and GitHub auth](https://github.com/Carldtitan/Accessifix/pull/2).** Five findings, including a genuine security catch: a **`repo`-scoped GitHub OAuth token was being copied onto the session object**, which is serialised to the browser. A `repo`-scoped token reachable from the browser is full account access, not merely a leak. Fixed by removing the token from the session *and* the JWT — `getGitHubAccessToken()` now reads it from the `accounts` row, server-side only. The same review added a unique index on `runs(id, phase)` and a composite foreign key from `findings(run_id, phase)`, so a finding's phase can no longer drift from its run's; a silent drift would corrupt the before/after headline invisibly. One `Medium` (cross-run `runId`/`pageId` linking) was **dismissed with a written reason in the thread** — a single dispatcher owns insertion, so no write path constructs findings across runs. The PR carries a follow-up Qodo review against the final code.

Across the project, **Qodo raised 60+ findings across 14 pull requests.** Several were false-pass paths that would have made the audit worthless:

- **A missing build reported as success.** `axeRan` was derived from "violations is not `undefined`" — but that field defaults to `[]`, and callers can pass `axe: false`. A page where axe never ran was indistinguishable from a clean page, so contrast, page title and labels reported as *passing, untested*. `runAxe` now returns `{violations, ran}` and `TreeLaneInput.axeRan` is **required**, not optional — optional would reproduce the silent `false` the finding is about; required is a compile error until the dispatcher answers.
- **A suite that ran zero tests reported as passing.** Only Playwright was excluded from unit-test classification, so `test: "cypress run"` was executed without a served app and the environment failure blocked the PR. Cypress, TestCafe, Nightwatch and WebdriverIO now classify as e2e.
- **An axe-core outage making every finding look resolved** — the same root cause seen from the other end: a lane that could not run scored as a lane with nothing to report.
- **Approval never reached the harness.** The handoff card rendered its outcome banner on click without ever calling the server. Rewritten around a real submit state machine; with no `runId` or handler, the controls stay disabled and say so. The approval gate is the centrepiece of the demo, and a button that fakes it is worse than no button at all.
- **An ARIA tabs bug in our own UI** — every tab pointed `aria-controls` at one shared panel. This product detects exactly that class of bug; shipping it would have been indefensible.

Full per-PR record, written the same day each review landed: [`docs/QODO-NOTES.md`](docs/QODO-NOTES.md).

## AI assistance disclosure

This project was built with **Claude Code** (Anthropic). AI assistance was used throughout: architecture and specification drafting, the majority of the implementation code, the WCAG Skill packs, and this README. Every pull request was reviewed by **Qodo Merge**, and every High-severity finding was either fixed or dismissed with a written reason in the thread. Architectural decisions, the criterion mapping, the dismissals and the merges were human calls.

The models AccessiFix itself dispatches at run time are listed in the agent roster above.
