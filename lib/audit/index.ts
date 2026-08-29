/**
 * The audit layer's public surface.
 *
 * `lib/pipeline/lanes.ts` is the only file that should import from here by the
 * bare module name; everything else can reach for the specific module.
 *
 * What this barrel covers is the whole audit: TREE, the deterministic gate
 * (A3.2); the five model-backed lanes — VIS, ACT, MEDIA, CODE and PAGES — and
 * the scaffolding they share; and the scoring and delta layer (A2, A8) that
 * every lane's findings flow into.
 *
 * Nothing here is imported for its side effects, but four of these modules do
 * have one: `lanePolicy` runs at module load and throws if the roster in
 * `lib/harness/agents.ts` and the criteria table in `lib/db/criteria.ts` ever
 * disagree about what a lane owns. That is deliberate. A disagreement means
 * findings that pass the harness schema and are then discarded by the ledger,
 * which reads on the report as a clean page, so it fails the boot instead.
 *
 * ACT and CODE reach for `lib/browser` and `lib/github` through dynamic
 * `import()`, so importing this barrel does not pull the Daytona SDK or Octokit
 * into the graph for a caller that only wants TREE.
 */

export * from './types';
export * from './axe-map';
export * from './tree';
export * from './score';
export * from './lane';

export * from './lane-context';
export * from './model-lane';
export * from './vis-lane';
export * from './act-lane';
export * from './media-lane';
export * from './code-lane';
export * from './pages-lane';
