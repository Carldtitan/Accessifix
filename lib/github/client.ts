/**
 * GitHub, through the signed-in user's own OAuth token (A1.4).
 *
 * There is no bot account and no shared installation token. Every branch, every
 * commit and every pull request AccessiFix creates is attributed to the person
 * who asked for it, against a repository they already have write access to.
 * That is not a convenience — it is the reason the agent cannot reach further
 * than the human who invoked it, whatever it decides to do.
 *
 * Commits go through the Git Data API — blob, tree, commit, update-ref — rather
 * than the contents endpoint, because a patch set is several files and a
 * per-file commit would leave the branch in a half-fixed state if the process
 * died between them. One commit, one ref update, or nothing.
 *
 * Every write here takes a `WriteAuthorization` and refuses without one (A7.1).
 * A comment saying "callers should go through `openVerifiedPullRequest`" is a
 * convention, and a convention is not a gate — anything holding a token could
 * call straight past it. The three methods that change a repository therefore
 * check the human's approval against the operation they are about to perform,
 * at the boundary, where it cannot be skipped.
 */

import { Octokit } from '@octokit/rest';

import {
  assertApproved,
  fileDigests,
  type ApprovalOperation,
  type ApprovalRequest,
  type GateDecision,
  type WriteAction,
} from '@/lib/fix/gate';

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export interface RepoRef {
  readonly owner: string;
  readonly repo: string;
}

export interface FileContents {
  readonly path: string;
  /** Decoded UTF-8 contents. */
  readonly contents: string;
  /** Blob SHA, needed by anything that wants to update the file in place. */
  readonly sha: string;
  readonly size: number;
  /** The ref the file was read at, echoed back for the record. */
  readonly ref: string | null;
}

export interface CommitFile {
  /** Repository-relative path, forward slashes. */
  readonly path: string;
  /** Complete new contents. */
  readonly contents: string;
  /** File mode. Default `100644`; use `100755` for an executable. */
  readonly mode?: '100644' | '100755';
}

export interface CommitResult {
  readonly commitSha: string;
  readonly treeSha: string;
  readonly branch: string;
  readonly parentSha: string;
  readonly files: readonly string[];
  readonly url: string;
}

export interface BranchResult {
  readonly name: string;
  readonly sha: string;
  /**
   * The commit the branch was cut from, or — when it already existed — the base
   * its tip was checked against. Kept so a caller can pin `parentSha` rather than
   * trusting whatever the branch tip happens to be by the time it commits.
   */
  readonly baseSha: string;
  /** False when the branch already existed and was reused. */
  readonly created: boolean;
}

export interface PullRequestResult {
  readonly number: number;
  readonly url: string;
  readonly id: number;
  readonly head: string;
  readonly base: string;
  readonly draft: boolean;
}

export interface OpenPullRequestInput {
  readonly head: string;
  readonly base: string;
  readonly title: string;
  readonly body: string;
  readonly draft?: boolean;
  /** Reviewers to request. Silently skipped if the API refuses them. */
  readonly reviewers?: readonly string[];
  readonly labels?: readonly string[];
}

export interface CommitFilesInput {
  readonly branch: string;
  readonly message: string;
  readonly files: readonly CommitFile[];
  /** Commit onto this SHA instead of the branch tip. */
  readonly parentSha?: string;
}

/* -------------------------------------------------------------------------- */
/* Authorization (A7.1)                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The human's yes, carried to the write that needs it.
 *
 * Both halves are required: the request says what was asked, the decision says
 * what was answered, and neither alone authorises anything.
 */
export interface WriteAuthorization {
  readonly approval: ApprovalRequest;
  readonly decision: GateDecision | null | undefined;
}

/**
 * Refuse the write unless a human approved this exact operation.
 *
 * `expected` carries only the fields this particular call can establish from its
 * own arguments; anything omitted is taken from the approval, and so compares
 * equal. That is deliberate rather than a hole — `createBranch` cannot know
 * which bytes a later commit will carry, so it binds the repository and the
 * branch, and `commitFiles` binds the file digests where the bytes actually
 * exist. Every field is checked by whichever call is in a position to check it.
 */
function authorize(
  operation: string,
  authorization: WriteAuthorization | undefined,
  accepted: readonly WriteAction[],
  expected: Partial<Omit<ApprovalOperation, 'action'>> & { readonly repoFullName: string },
): void {
  if (!authorization) {
    throw new GitHubError(
      operation,
      'Refusing to write to a repository without a human approval (A7.1). ' +
        'Build one with `lib/fix/gate.ts` and pass it here.',
    );
  }

  const { approval, decision } = authorization;
  if (!accepted.includes(approval.action)) {
    throw new GitHubError(
      operation,
      `The approval on hand is for "${approval.action}", not for ${accepted
        .map((action) => `"${action}"`)
        .join(' or ')}.`,
    );
  }

  const approved = approval.operation;
  assertApproved(approval, decision, {
    action: approval.action,
    repoFullName: expected.repoFullName,
    branch: expected.branch !== undefined ? expected.branch : approved.branch,
    base: expected.base !== undefined ? expected.base : approved.base,
    title: expected.title !== undefined ? expected.title : approved.title,
    files: expected.files !== undefined ? expected.files : approved.files,
    commitSha: expected.commitSha !== undefined ? expected.commitSha : approved.commitSha,
  });
}

/** The digests `ApprovalOperation.files` carries, for a commit's file set. */
function digestsOf(files: readonly CommitFile[]): string[] {
  return fileDigests(
    files.map((file) => ({ path: normalizePath(file.path), contents: file.contents })),
  );
}

function repoFullNameOf(repo: RepoLike): string {
  const { owner, repo: name } = asRepo(repo);
  return `${owner}/${name}`;
}

/** Anything the GitHub API refused, with the status that says why. */
export class GitHubError extends Error {
  readonly status: number | undefined;
  readonly operation: string;

  constructor(operation: string, message: string, status?: number, cause?: unknown) {
    super(`${operation}: ${message}`, cause === undefined ? undefined : { cause });
    this.name = 'GitHubError';
    this.status = status;
    this.operation = operation;
  }
}

function statusOf(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const status = (error as { status: unknown }).status;
    if (typeof status === 'number') return status;
  }
  return undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* -------------------------------------------------------------------------- */
/* Client                                                                     */
/* -------------------------------------------------------------------------- */

export interface GitHubClientOptions {
  readonly userAgent?: string;
  /** For GitHub Enterprise. Defaults to the public API. */
  readonly baseUrl?: string;
}

/** `owner/repo` -> `{ owner, repo }`, rejecting anything that is not that. */
export function parseRepoRef(fullName: string): RepoRef {
  const parts = fullName.trim().replace(/^\/+|\/+$/g, '').split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new GitHubError('parseRepoRef', `"${fullName}" is not an owner/repo pair.`);
  }
  return { owner: parts[0], repo: parts[1].replace(/\.git$/, '') };
}

/** Accepts either shape at the boundary, so callers can pass whichever they hold. */
export type RepoLike = RepoRef | string;

function asRepo(repo: RepoLike): RepoRef {
  return typeof repo === 'string' ? parseRepoRef(repo) : repo;
}

export class GitHubClient {
  private readonly octokit: Octokit;

  constructor(token: string, options: GitHubClientOptions = {}) {
    if (!token || token.trim().length === 0) {
      throw new GitHubError(
        'GitHubClient',
        'No GitHub token. Pull requests are opened with the signed-in user’s own token (A1.4).',
      );
    }
    this.octokit = new Octokit({
      auth: token,
      userAgent: options.userAgent ?? 'accessifix',
      ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    });
  }

  /** Escape hatch for endpoints this wrapper does not cover. */
  get rest(): Octokit {
    return this.octokit;
  }

  /** The login of the token's owner, for attribution in the run view. */
  async getAuthenticatedLogin(): Promise<string> {
    try {
      const { data } = await this.octokit.rest.users.getAuthenticated();
      return data.login;
    } catch (error) {
      throw new GitHubError(
        'getAuthenticatedLogin',
        messageOf(error),
        statusOf(error),
        error,
      );
    }
  }

  /**
   * The repository's default branch. Every branch AccessiFix creates is cut
   * from it and every pull request targets it, unless the caller says otherwise.
   */
  async getDefaultBranch(repo: RepoLike): Promise<string> {
    const { owner, repo: name } = asRepo(repo);
    try {
      const { data } = await this.octokit.rest.repos.get({ owner, repo: name });
      return data.default_branch;
    } catch (error) {
      throw new GitHubError(
        'getDefaultBranch',
        `${owner}/${name}: ${messageOf(error)}`,
        statusOf(error),
        error,
      );
    }
  }

  /**
   * Read one file. Returns null when it does not exist at that ref, because
   * "the finding points at a file that is not there" is an ordinary outcome
   * the FIX pass has to handle, not an exception.
   */
  async getFileContents(
    repo: RepoLike,
    path: string,
    ref?: string,
  ): Promise<FileContents | null> {
    const { owner, repo: name } = asRepo(repo);
    try {
      const { data } = await this.octokit.rest.repos.getContent({
        owner,
        repo: name,
        path,
        ...(ref ? { ref } : {}),
      });

      if (Array.isArray(data)) {
        throw new GitHubError('getFileContents', `${path} is a directory, not a file.`);
      }
      if (data.type !== 'file' || typeof data.content !== 'string') {
        throw new GitHubError('getFileContents', `${path} is a ${data.type}, not a file.`);
      }

      return {
        path: data.path,
        contents: Buffer.from(data.content, 'base64').toString('utf8'),
        sha: data.sha,
        size: data.size,
        ref: ref ?? null,
      };
    } catch (error) {
      if (error instanceof GitHubError) throw error;
      if (statusOf(error) === 404) return null;
      throw new GitHubError(
        'getFileContents',
        `${owner}/${name}:${path}: ${messageOf(error)}`,
        statusOf(error),
        error,
      );
    }
  }

  /** Read several files at once. Missing files come back as null entries. */
  async getFiles(
    repo: RepoLike,
    paths: readonly string[],
    ref?: string,
  ): Promise<Map<string, FileContents | null>> {
    const entries = await Promise.all(
      paths.map(
        async (path) => [path, await this.getFileContents(repo, path, ref)] as const,
      ),
    );
    return new Map(entries);
  }

  /**
   * Create a branch, or reuse it if it is already there.
   *
   * Reuse rather than failure is deliberate: a run that was interrupted after
   * pushing but before opening the pull request has to be able to resume (A12).
   *
   * Reuse is not the same as trust. The approval named a base; a branch that
   * merely shares the name is evidence of nothing. It can be a collision with
   * somebody else's work, a leftover from a run against different history, or a
   * ref someone repointed by hand. `commitFiles` defaults its parent to the
   * branch tip, so an unchecked tip becomes the parent of the approved patch and
   * the human ends up reading a diff cut from history they never saw. The tip is
   * therefore measured against the base that was authorised, and a branch that is
   * not this run's to resume is refused out loud instead of written to.
   *
   * A7.1: a branch is a write, so it needs the human's yes for this repository
   * and this branch name before anything reaches the remote.
   */
  async createBranch(
    repo: RepoLike,
    branch: string,
    authorization: WriteAuthorization,
    fromRef?: string,
  ): Promise<BranchResult> {
    const { owner, repo: name } = asRepo(repo);
    authorize('createBranch', authorization, ['push-branch'], {
      repoFullName: repoFullNameOf(repo),
      branch,
      ...(fromRef === undefined ? {} : { base: fromRef }),
    });

    const base = fromRef ?? (await this.getDefaultBranch(repo));
    // Resolved before the existence check, because the base is what an existing
    // branch has to be measured against — not merely what a new one is cut from.
    const baseSha = await this.resolveSha(repo, base);

    const existing = await this.getBranchSha(repo, branch);
    if (existing) {
      await this.assertReusableBranch(repo, branch, existing, base, baseSha);
      return { name: branch, sha: existing, baseSha, created: false };
    }

    try {
      const { data } = await this.octokit.rest.git.createRef({
        owner,
        repo: name,
        ref: `refs/heads/${branch}`,
        sha: baseSha,
      });
      return { name: branch, sha: data.object.sha, baseSha, created: true };
    } catch (error) {
      // Lost a race with another writer; the branch exists now either way. It
      // still has to be the branch this run asked for — losing a race is not a
      // reason to skip the check.
      if (statusOf(error) === 422) {
        const sha = await this.getBranchSha(repo, branch);
        if (sha) {
          await this.assertReusableBranch(repo, branch, sha, base, baseSha);
          return { name: branch, sha, baseSha, created: false };
        }
      }
      throw new GitHubError(
        'createBranch',
        `${owner}/${name}@${branch}: ${messageOf(error)}`,
        statusOf(error),
        error,
      );
    }
  }

  /**
   * Refuse an existing branch that is not the one this run would have created.
   *
   * Two things have to hold before an approved patch may be committed onto a
   * branch AccessiFix did not just create:
   *
   *  1. The tip descends from the approved base. If that base is not in the
   *     branch's history, the branch was cut from something else entirely and
   *     the commit about to be written would sit on unrelated history.
   *  2. Whatever the branch carries on top of that base is the signed-in user's
   *     own. Under A1.4 every commit AccessiFix makes is attributed to the
   *     person who asked for it, so a same-named branch holding somebody else's
   *     commits is not an interrupted run — it is a collision, and those commits
   *     would ride into the pull request underneath the approved patch.
   *
   * A commit GitHub cannot attribute counts as somebody else's. "We could not
   * tell" is not the same as "it was ours", and this is the one place where
   * guessing wrong writes to another person's repository.
   */
  private async assertReusableBranch(
    repo: RepoLike,
    branch: string,
    tipSha: string,
    base: string,
    baseSha: string,
  ): Promise<void> {
    // Nothing on top of the base at all: created but never committed to, which
    // is exactly the interrupted run that reuse exists for.
    if (tipSha === baseSha) return;

    const { owner, repo: name } = asRepo(repo);
    let comparison;
    try {
      const { data } = await this.octokit.rest.repos.compareCommitsWithBasehead({
        owner,
        repo: name,
        basehead: `${baseSha}...${tipSha}`,
        per_page: 100,
      });
      comparison = data;
    } catch (error) {
      throw new GitHubError(
        'createBranch',
        `Branch "${branch}" already exists at ${shortSha(tipSha)} and its relationship to the ` +
          `approved base "${base}" (${shortSha(baseSha)}) could not be established: ` +
          `${messageOf(error)}. Refusing to commit onto an unverified branch.`,
        statusOf(error),
        error,
      );
    }

    if (comparison.status !== 'identical' && comparison.status !== 'ahead') {
      throw new GitHubError(
        'createBranch',
        `Branch "${branch}" already exists at ${shortSha(tipSha)}, which does not descend from ` +
          `the approved base "${base}" (${shortSha(baseSha)}) — GitHub compares them as ` +
          `"${comparison.status}". Committing onto it would put the approved patch on history ` +
          'the human never saw. Delete the branch or use a different branch name.',
        409,
      );
    }

    const commits = comparison.commits ?? [];
    const ahead = comparison.ahead_by ?? commits.length;
    if (ahead > commits.length) {
      throw new GitHubError(
        'createBranch',
        `Branch "${branch}" is ${ahead} commit(s) ahead of the approved base "${base}", more ` +
          'than one comparison can list, so what it carries cannot be accounted for. That is ' +
          'not an interrupted AccessiFix run. Use a different branch name.',
        409,
      );
    }

    const login = await this.getAuthenticatedLogin();
    const foreign = commits.filter(
      (commit) => (commit.author?.login ?? '').toLowerCase() !== login.toLowerCase(),
    );
    if (foreign.length > 0) {
      const first = foreign[0];
      const who = first?.author?.login ?? 'an unattributed author';
      throw new GitHubError(
        'createBranch',
        `Branch "${branch}" already exists and carries ${foreign.length} commit(s) above the ` +
          `approved base that are not ${login}'s (${shortSha(first?.sha ?? tipSha)} by ` +
          `${who}). That is another branch with the same name, not this run's to resume, and ` +
          'those commits would end up inside the pull request. Use a different branch name.',
        409,
      );
    }
  }

  /** The tip SHA of a branch, or null when the branch does not exist. */
  async getBranchSha(repo: RepoLike, branch: string): Promise<string | null> {
    const { owner, repo: name } = asRepo(repo);
    try {
      const { data } = await this.octokit.rest.git.getRef({
        owner,
        repo: name,
        ref: `heads/${branch}`,
      });
      return data.object.sha;
    } catch (error) {
      if (statusOf(error) === 404) return null;
      throw new GitHubError(
        'getBranchSha',
        `${owner}/${name}@${branch}: ${messageOf(error)}`,
        statusOf(error),
        error,
      );
    }
  }

  /**
   * Commit a patch set to a branch as a single commit.
   *
   * Blobs, then a tree layered on the parent commit's tree, then a commit, then
   * one ref update. Every file lands together or none of them do, so a branch
   * never carries half a fix.
   *
   * A7.1: this is the call that writes the bytes, so it is the call that binds
   * them — the approval's file digests must match the contents about to be
   * committed, not merely their paths or their count. A branch approval covers
   * it, because its prose already says which files are going onto the branch.
   */
  async commitFiles(
    repo: RepoLike,
    input: CommitFilesInput,
    authorization: WriteAuthorization,
  ): Promise<CommitResult> {
    const { owner, repo: name } = asRepo(repo);

    if (input.files.length === 0) {
      throw new GitHubError('commitFiles', 'Refusing to create an empty commit.');
    }

    authorize('commitFiles', authorization, ['commit-files', 'push-branch'], {
      repoFullName: repoFullNameOf(repo),
      branch: input.branch,
      files: digestsOf(input.files),
    });

    try {
      const parentSha = input.parentSha ?? (await this.requireBranchSha(repo, input.branch));
      const { data: parent } = await this.octokit.rest.git.getCommit({
        owner,
        repo: name,
        commit_sha: parentSha,
      });

      const blobs = await Promise.all(
        input.files.map(async (file) => {
          const { data } = await this.octokit.rest.git.createBlob({
            owner,
            repo: name,
            content: Buffer.from(file.contents, 'utf8').toString('base64'),
            encoding: 'base64',
          });
          return {
            path: normalizePath(file.path),
            mode: (file.mode ?? '100644') as '100644' | '100755',
            type: 'blob' as const,
            sha: data.sha,
          };
        }),
      );

      const { data: tree } = await this.octokit.rest.git.createTree({
        owner,
        repo: name,
        base_tree: parent.tree.sha,
        tree: blobs,
      });

      const { data: commit } = await this.octokit.rest.git.createCommit({
        owner,
        repo: name,
        message: input.message,
        tree: tree.sha,
        parents: [parentSha],
      });

      await this.octokit.rest.git.updateRef({
        owner,
        repo: name,
        ref: `heads/${input.branch}`,
        sha: commit.sha,
        force: false,
      });

      return {
        commitSha: commit.sha,
        treeSha: tree.sha,
        branch: input.branch,
        parentSha,
        files: input.files.map((file) => normalizePath(file.path)),
        url: commit.html_url,
      };
    } catch (error) {
      if (error instanceof GitHubError) throw error;
      throw new GitHubError(
        'commitFiles',
        `${owner}/${name}@${input.branch}: ${messageOf(error)}`,
        statusOf(error),
        error,
      );
    }
  }

  /**
   * Open the pull request.
   *
   * The last irreversible step in the run, and the one A7.1 pauses before. The
   * pause is enforced here as well as in `openVerifiedPullRequest`: that
   * function is the only path that also checks the build and the test suite,
   * but this method must not be reachable without an approval either, or the
   * gate would be a convention rather than a rule.
   */
  async openPullRequest(
    repo: RepoLike,
    input: OpenPullRequestInput,
    authorization: WriteAuthorization,
  ): Promise<PullRequestResult> {
    const { owner, repo: name } = asRepo(repo);
    authorize('openPullRequest', authorization, ['open-pull-request'], {
      repoFullName: repoFullNameOf(repo),
      branch: input.head,
      base: input.base,
      title: input.title,
    });

    try {
      const { data } = await this.octokit.rest.pulls.create({
        owner,
        repo: name,
        title: input.title,
        body: input.body,
        head: input.head,
        base: input.base,
        draft: input.draft ?? false,
        maintainer_can_modify: true,
      });

      // Labels and reviewers are courtesies. A repository that refuses them
      // (no permission, unknown login, protected label set) must not turn an
      // opened pull request into a failed run.
      if (input.labels && input.labels.length > 0) {
        await this.octokit.rest.issues
          .addLabels({ owner, repo: name, issue_number: data.number, labels: [...input.labels] })
          .catch(() => undefined);
      }
      if (input.reviewers && input.reviewers.length > 0) {
        await this.octokit.rest.pulls
          .requestReviewers({
            owner,
            repo: name,
            pull_number: data.number,
            reviewers: [...input.reviewers],
          })
          .catch(() => undefined);
      }

      return {
        number: data.number,
        url: data.html_url,
        id: data.id,
        head: data.head.ref,
        base: data.base.ref,
        draft: Boolean(data.draft),
      };
    } catch (error) {
      throw new GitHubError(
        'openPullRequest',
        `${owner}/${name} ${input.head} -> ${input.base}: ${messageOf(error)}`,
        statusOf(error),
        error,
      );
    }
  }

  private async requireBranchSha(repo: RepoLike, branch: string): Promise<string> {
    const sha = await this.getBranchSha(repo, branch);
    if (!sha) {
      throw new GitHubError('commitFiles', `Branch "${branch}" does not exist.`, 404);
    }
    return sha;
  }

  /** Resolve a branch, tag or SHA to a commit SHA. */
  private async resolveSha(repo: RepoLike, ref: string): Promise<string> {
    const branchSha = await this.getBranchSha(repo, ref);
    if (branchSha) return branchSha;

    const { owner, repo: name } = asRepo(repo);
    try {
      const { data } = await this.octokit.rest.repos.getCommit({
        owner,
        repo: name,
        ref,
      });
      return data.sha;
    } catch (error) {
      throw new GitHubError(
        'resolveSha',
        `${owner}/${name}@${ref}: ${messageOf(error)}`,
        statusOf(error),
        error,
      );
    }
  }
}

/** Seven characters, because that is what a human reads in an error message. */
function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

/* -------------------------------------------------------------------------- */
/* Function forms                                                             */
/* -------------------------------------------------------------------------- */

/** Build a client from the signed-in user's token (`session.accessToken`). */
export function createGitHubClient(
  token: string,
  options: GitHubClientOptions = {},
): GitHubClient {
  return new GitHubClient(token, options);
}

/** Accept a client or a bare token wherever one is needed. */
export type GitHubAuth = GitHubClient | string;

function resolve(auth: GitHubAuth): GitHubClient {
  return typeof auth === 'string' ? new GitHubClient(auth) : auth;
}

export function getDefaultBranch(auth: GitHubAuth, repo: RepoLike): Promise<string> {
  return resolve(auth).getDefaultBranch(repo);
}

export function getFileContents(
  auth: GitHubAuth,
  repo: RepoLike,
  path: string,
  ref?: string,
): Promise<FileContents | null> {
  return resolve(auth).getFileContents(repo, path, ref);
}

/*
 * The three write forms take the human's approval as a required argument. It is
 * not a convenience the caller may drop: the type is what makes "no repository
 * write without a human" checkable at compile time rather than hoped for.
 */

export function createBranch(
  auth: GitHubAuth,
  repo: RepoLike,
  branch: string,
  authorization: WriteAuthorization,
  fromRef?: string,
): Promise<BranchResult> {
  return resolve(auth).createBranch(repo, branch, authorization, fromRef);
}

export function commitFiles(
  auth: GitHubAuth,
  repo: RepoLike,
  input: CommitFilesInput,
  authorization: WriteAuthorization,
): Promise<CommitResult> {
  return resolve(auth).commitFiles(repo, input, authorization);
}

export function openPullRequest(
  auth: GitHubAuth,
  repo: RepoLike,
  input: OpenPullRequestInput,
  authorization: WriteAuthorization,
): Promise<PullRequestResult> {
  return resolve(auth).openPullRequest(repo, input, authorization);
}
