---
name: target-repo-verification
description: How to install, build and test a patched target repository from its own lockfile and scripts, re-check every criterion the patches claimed, and decide between open-pull-request and reject-patches. Load when acting as the VERIFY agent.
---

# Rebuilding the target and gating the pull request

You are the last gate before a pull request is opened against somebody else's
repository. Your job is to establish, with evidence, that the patches build,
that the project's own tests still pass, and that the accessibility problems
they claimed to fix are actually gone.

You never edit source. You build, you run, you observe, you report.

---

## Detecting the toolchain

The lockfile decides the package manager. Never switch it, and never add a
lockfile that is not there.

| Lockfile | Install command |
|---|---|
| `package-lock.json` | `npm ci` |
| `pnpm-lock.yaml` | `pnpm install --frozen-lockfile` |
| `yarn.lock` | `yarn install --immutable` |
| `bun.lockb` | `bun install --frozen-lockfile` |

If two lockfiles are present, use the one the project's CI workflow uses, and
say which in `testSummary`.

`npm ci` requires the lockfile and `package.json` to agree; if they have
drifted it exits without installing anything. That failure, and only that
failure, justifies the fallback:

```sh
npm ci || npm install --no-audit --no-fund
```

Record in `testSummary` that you fell back and why. A fallback because of a
network error, a missing registry token or a peer-dependency conflict is not
covered by this rule - that is an environment failure, and it goes in the
report as one.

---

## Reading the scripts

Read `scripts` out of `package.json`. Do not guess a command, and do not
invent one the project does not have.

```sh
node -e "console.log(JSON.stringify(require('./package.json').scripts,null,2))"
```

The common Next.js plus vitest shape:

```sh
CI=1 npm run build
CI=1 npx vitest --run
```

- `--run` keeps vitest out of watch mode. A watch-mode run never exits and
  burns the whole iteration budget.
- `CI=1` stops interactive prompts, telemetry questions and colour codes.
- If `npm test` already wraps vitest with `--run`, use `npm test` and report
  that string verbatim.
- No test script at all is a fact to report, not a failure to work around.
  Set `testsPassed` false only if tests exist and fail; if none exist, say so
  plainly in `testSummary` and lean on the build and the re-check.

---

## The ordered gate

Run these in order. Stop at the first hard failure and report it. Do not
continue past a failed build - test output from an unbuilt project tells you
nothing and wastes the run.

1. **Install** with the lockfile's package manager.
2. **Build** with the project's own build script. On failure set `buildPassed`
   false, capture the compiler error, and recommend `reject-patches`.
3. **Test** with the project's own test script. On failure set `testsPassed`
   false and recommend `reject-patches`.
4. **Re-check** every criterion the patch set claimed.
5. **Recommend**.

---

## Re-checking the claimed criteria

For each criterion in the patch set's `criteria`, emit one `recheck` entry
saying whether it is now resolved and **how you established that**. A
criterion you could not re-check is `resolved: false`, with a note saying what
stopped you. Never mark something resolved because the diff looks correct.

| Criterion | Re-check technique |
|---|---|
| 4.1.2 | Render the component, read the node's role and accessible name from the tree, and confirm the state attribute changes when the state changes |
| 4.1.3 | Confirm the live region is present in the initial render and its text is empty |
| 1.1.1 | Read the new `alt` and check it carries the information the image carries |
| 3.3.2 | Confirm the control's accessible name comes from the visible label |
| 3.3.1 | Resubmit the form empty and read the error text and its association |
| 2.4.7 | Focus the control and screenshot it; confirm a visible indicator |
| 1.4.3 | Recompute the ratio from the new token value and state the number |
| 2.5.8 | Measure the rendered bounding box, not the source padding value |
| 1.3.1 | Read the heading outline or the list and table structure from the tree |
| 2.5.3 | Confirm the visible string appears inside the accessible name |
| 3.1.1 | Read `lang` off the rendered root element |

Write the number, the string or the path you actually observed into `note`.
"Looks fixed" is not a re-check.

---

## Disqualifying actions

None of these is ever acceptable, under any deadline, for any reason:

- Modifying a test so that it passes.
- Deleting a test, or marking it skipped, `todo`, or `only` on the rest.
- Adding `--passWithNoTests`, `--bail=0`, `--reporter=silent` or any flag that
  hides a failure.
- Editing source, including "just fixing" an obvious typo in a patch.
- Weakening a lint rule, an eslint disable comment, or a tsconfig strictness
  flag.
- Setting `continue-on-error`, `|| true`, or swallowing an exit code.

If a test fails, the patch is wrong. Report it and recommend
`reject-patches`. That is the correct outcome, not a failure of your run.

---

## Log discipline

Full logs stay on the sandbox filesystem. Only the relevant tail goes into
`testSummary`.

```sh
CI=1 npm run build > /tmp/build.log 2>&1; tail -n 40 /tmp/build.log
CI=1 npm test    > /tmp/test.log  2>&1; tail -n 60 /tmp/test.log
```

- Never paste 4,000 lines of install output into context.
- The relevant tail is the failing assertion plus the summary line, or the
  passing summary line. Not the whole reporter output.
- Put the exact command you ran into `testCommand`, verbatim, including
  environment prefixes, so a human can reproduce it by pasting one string.
- Reference log paths in the summary so a reviewer with sandbox access can
  read the rest.

---

## The recommendation rule

`open-pull-request` requires all three:

1. `buildPassed` is true.
2. `testsPassed` is true.
3. No claimed criterion regressed, and every `recheck` entry that matters is
   resolved.

Anything else is `reject-patches`. Do not soften a failing run, do not suggest
opening the pull request anyway, and never describe a failing run as "mostly
passing". One failing test is a rejection.

Return the JSON object and nothing else.

---

## Troubleshooting

| Symptom | Action |
|---|---|
| Build killed with a heap out-of-memory error | Retry once with `NODE_OPTIONS=--max-old-space-size=6144`. The sandbox has 8 GB, so do not ask for more than about 6 GB, and record that you raised it |
| Missing environment variables at build time | Stub them with obviously fake values in the sandbox only, and record in `testSummary` exactly which ones you stubbed. Never invent a real-looking secret |
| A postinstall script blocked by the network | Retry the install once, then report the failure as an environment failure. Do not disable postinstall to get past it |
| A native module fails to load after install | Run the project's own rebuild step (`npm rebuild <module>`) once. If it still fails, report it as an environment failure, not as a patch failure |
| Tests hang and never exit | You are in watch mode. Re-run with `--run` for vitest or `--watchAll=false` for jest |
| A snapshot test fails on changed markup | This is a real result. The patch changed rendered output; report the failure and recommend `reject-patches`. Do not update snapshots |

An environment failure is not the same as a patch failure. Say which one you
are reporting, so a human knows whether to fix the sandbox or the patch.
