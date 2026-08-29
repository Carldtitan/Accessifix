/**
 * The audit layer's public surface.
 *
 * `lib/pipeline/lanes.ts` is the only file that should import from here by the
 * bare module name; everything else can reach for the specific module.
 *
 * What this barrel covers is TREE — the deterministic gate (A3.2) — and the
 * scoring and delta layer (A2, A8) that every lane's findings flow into. The
 * VIS, ACT, PAGES, MEDIA and CODE lanes the roster also places in `lib/audit`
 * are separate modules; when they land, re-export them from here alongside
 * `runTreeLane`.
 */

export * from './types';
export * from './axe-map';
export * from './tree';
export * from './score';
export * from './lane';
