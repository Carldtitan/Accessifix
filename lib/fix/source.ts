/**
 * Getting from a stored patch row back to the bytes it describes.
 *
 * FIX computes its diffs on the host and stores them; the `patches` table keeps
 * `file_path` and `diff` and nothing more. VERIFY and the pull request both need
 * the complete patched file — one to write into the build sandbox, the other to
 * commit and to digest for the approval — so the contents have to come back from
 * somewhere, and the only honest source is the file the diff was computed
 * against plus the diff itself.
 *
 * That is what this module does, and the reason it is one module rather than
 * three call sites is that getting it wrong is not a typing mistake, it is
 * unreviewed bytes in somebody's repository. `rebuildFilePatch` re-derives the
 * diff from what it reconstructed and refuses anything that does not reproduce
 * the original byte for byte, so a file that moved, drifted or was rewritten
 * since FIX read it comes back as a named failure instead of a patch.
 */

import { rebuildFilePatch, type FilePatch } from './patch';

/**
 * Repository-relative, forward slashes, no leading `./` or `/`.
 *
 * The same normalisation `lib/github/client.ts` applies before it digests a
 * commit's files. Doing it here too keeps the path that was approved and the
 * path that is written identical, so a Windows-shaped path in a stored row
 * cannot make an otherwise valid approval look like a different file set.
 */
export function normalizeRepoPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

/** Local alias, so the body of this module reads as it did. */
const normalizePath = normalizeRepoPath;

/**
 * The path, safe to interpolate into a Contents API URL.
 *
 * `encodeURI` is the wrong tool here: it leaves the reserved delimiters alone,
 * so a file legitimately named `report?draft.md` or `notes#1.md` — both valid in
 * Git and on every filesystem this runs against — turns the rest of the path
 * into a query string or a fragment, GitHub answers 404, and FIX reports the
 * file as missing rather than as a file it could not address. `%` is worse
 * again: it survives `encodeURI` untouched and is then read back as the start
 * of an escape sequence.
 *
 * So every segment is encoded on its own and the `/` separators are put back.
 * `encodeURIComponent` escapes exactly the characters that would otherwise
 * change the URL's structure and leaves the unreserved set alone, which is why
 * an ordinary path still comes out looking like itself.
 */
function encodeRepoPath(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

/** A stored patch row, in the shape the pipeline seam passes it around in. */
export interface StoredPatchInput {
  readonly filePath: string;
  readonly diff: string;
  readonly criteria?: readonly string[];
  readonly findingIds?: readonly string[];
  readonly rationale?: string;
  readonly risk?: string | null;
}

/** A patch that could not be turned back into bytes, and why. */
export interface UnmaterializedPatch {
  readonly filePath: string;
  readonly reason: string;
}

export interface MaterializedPatches {
  readonly patches: readonly FilePatch[];
  readonly failures: readonly UnmaterializedPatch[];
}

/**
 * Read one file from a repository at a ref.
 *
 * Null when it is not there. A finding pointing at a file that no longer exists
 * is an ordinary outcome the caller reports, not an exception.
 */
export async function readRepoFile(
  repoFullName: string,
  accessToken: string,
  path: string,
  ref?: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const [owner, repo] = repoFullName.split('/');
  if (!owner || !repo) return null;

  const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${encodeRepoPath(path)}${query}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github.raw',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      ...(signal ? { signal } : {}),
    },
  );

  if (!response.ok) return null;
  return response.text();
}

/**
 * Turn stored patch rows back into complete `FilePatch`es.
 *
 * Every patch either comes back with contents whose diff against the fetched
 * file is exactly the stored diff, or it comes back in `failures` with the
 * reason. There is no third outcome, and in particular there is no "close
 * enough" — a patch that cannot be reproduced is not applied.
 *
 * This is the per-file *report*. Anything that then verifies, commits or claims
 * a fix must go through `materializeAllPatches` below, which turns that report
 * into the all-or-nothing decision those callers actually need.
 */
export async function materializePatches(
  input: {
    readonly repoFullName: string;
    readonly accessToken: string;
    readonly patches: readonly StoredPatchInput[];
    /** Branch, tag or SHA the diffs were computed against. Default: the remote HEAD. */
    readonly ref?: string;
    readonly signal?: AbortSignal;
  },
): Promise<MaterializedPatches> {
  const patches: FilePatch[] = [];
  const failures: UnmaterializedPatch[] = [];

  for (const stored of input.patches) {
    const filePath = normalizePath(stored.filePath);

    if (input.signal?.aborted) {
      failures.push({ filePath, reason: 'the run was cancelled' });
      continue;
    }

    let original: string | null;
    try {
      original = await readRepoFile(
        input.repoFullName,
        input.accessToken,
        filePath,
        input.ref,
        input.signal,
      );
    } catch (error) {
      failures.push({
        filePath,
        reason: `could not be read from ${input.repoFullName}: ${(error as Error).message}`,
      });
      continue;
    }

    if (original === null) {
      failures.push({
        filePath,
        reason: `does not exist in ${input.repoFullName}${input.ref ? ` at ${input.ref}` : ''}`,
      });
      continue;
    }

    const rebuilt = rebuildFilePatch(filePath, original, stored.diff, {
      ...(stored.findingIds === undefined ? {} : { findingIds: stored.findingIds }),
      ...(stored.criteria === undefined ? {} : { criteria: stored.criteria }),
      ...(stored.rationale === undefined ? {} : { rationale: stored.rationale }),
      ...(stored.risk === undefined ? {} : { risk: stored.risk }),
    });

    if (!rebuilt) {
      failures.push({
        filePath: stored.filePath,
        reason:
          'the stored diff no longer applies to this file — it has changed since the fix was ' +
          'written, so the patch is not the change that was reviewed',
      });
      continue;
    }

    patches.push(rebuilt);
  }

  return { patches, failures };
}

/**
 * The materialization refused, with the files it could not rebuild named.
 *
 * Carries `failures` so a caller that wants to phrase the refusal in its own
 * words does not have to re-derive them from the message.
 */
export class PatchesDoNotApplyError extends Error {
  readonly failures: readonly UnmaterializedPatch[];

  constructor(message: string, failures: readonly UnmaterializedPatch[]) {
    super(message);
    this.name = 'PatchesDoNotApplyError';
    this.failures = failures;
  }
}

/**
 * Materialize the whole patch set, or none of it.
 *
 * `materializePatches` reports per-file outcomes because rebuilding is per-file;
 * that is the right shape for a report and the wrong shape for a decision.
 * VERIFY and the pull request are decisions about *a fix*, not about whichever
 * part of it happened to survive, and a subset is not a smaller version of the
 * same change — it is a different change nobody proposed:
 *
 *  - VERIFY building the surviving files proves the tree compiles without the
 *    dropped ones, and then recommends a pull request on that evidence.
 *  - The pull request commits the surviving files and cites every criterion the
 *    full set claimed, so it says it fixed things it did not touch.
 *
 * Both are the same failure — a claim that outruns the bytes — and this product
 * is worth nothing if its claims are not exact. So a single unrebuilt file
 * stops the run here, before anything is verified and before anything is
 * written, and the run says which files and why.
 *
 * An empty proposal is refused for the same reason: there is no fix to verify
 * and nothing to open a pull request with.
 */
export async function materializeAllPatches(
  input: {
    readonly repoFullName: string;
    readonly accessToken: string;
    readonly patches: readonly StoredPatchInput[];
    readonly ref?: string;
    readonly signal?: AbortSignal;
  },
): Promise<readonly FilePatch[]> {
  const at = input.ref ? `${input.repoFullName}@${input.ref}` : input.repoFullName;

  if (input.patches.length === 0) {
    throw new PatchesDoNotApplyError(
      `No patches were proposed for ${at}, so there is nothing to apply.`,
      [],
    );
  }

  const { patches, failures } = await materializePatches(input);

  // The length check is not redundant with `failures`: it is the invariant that
  // every proposed patch produced exactly one outcome, and it is cheaper to
  // assert than to debug.
  if (failures.length > 0 || patches.length !== input.patches.length) {
    const named = failures.map((f) => `${f.filePath}: ${f.reason}`).join('; ');
    throw new PatchesDoNotApplyError(
      `${failures.length || input.patches.length - patches.length} of the ` +
        `${input.patches.length} proposed patch(es) could not be rebuilt against ${at}. ` +
        'A partial fix would claim criteria it never repaired, so the whole set is refused' +
        (named ? `: ${named}` : '.'),
      failures,
    );
  }

  return patches;
}
