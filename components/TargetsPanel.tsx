"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";

import { Icon } from "./Icon";
import { StatusLabel } from "./StatusLabel";
import { formatUtcDate, type TargetListItem } from "./run-data";

/* -------------------------------------------------------------------------- */
/* Wire helpers                                                               */
/* -------------------------------------------------------------------------- */

interface ApiError {
  error?: string;
  reason?: string;
}

/** The stated reason, in the words the API used. Never a bare status code. */
async function readError(response: Response, fallback: string): Promise<string> {
  let body: ApiError | null = null;
  try {
    body = (await response.json()) as ApiError;
  } catch {
    body = null;
  }
  const stated = [body?.error, body?.reason].filter(Boolean).join(" ");
  return stated || `${fallback} The server answered ${response.status}.`;
}

/* -------------------------------------------------------------------------- */
/* The panel                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Connect a repository to its deployed URL, and start a run against it.
 *
 * Both buttons reach the real API: `POST /api/targets` checks the deployment
 * answers 2xx before the target exists (A1.3), and `POST /api/runs` takes the
 * conductor lease and returns the run id. Neither reports an outcome it did not
 * obtain — a refusal is shown with the reason the server gave.
 *
 * Accessibility contract:
 * - Every input has a real `<label>` and its help text is wired with
 *   `aria-describedby`; the error joins that description rather than replacing
 *   it, so the field still explains itself once it has failed.
 * - `aria-invalid` tracks the real validation state.
 * - Progress and outcome are announced through polite live regions. Focus is
 *   never moved: a keyboard user retries from where they already are.
 * - The submit button stays enabled and `aria-disabled` while in flight, so it
 *   keeps focus rather than dropping the user to the top of the document.
 */
export function TargetsPanel({ targets }: { targets: ReadonlyArray<TargetListItem> }) {
  const router = useRouter();
  const formId = useId();

  const [repo, setRepo] = useState("");
  const [url, setUrl] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connectNote, setConnectNote] = useState<string | null>(null);

  const [startingId, setStartingId] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);

  const repoId = `${formId}-repo`;
  const urlId = `${formId}-url`;
  const repoHelpId = `${repoId}-help`;
  const urlHelpId = `${urlId}-help`;
  const errorId = `${formId}-error`;

  async function connect(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (connecting) return;

    setConnecting(true);
    setConnectError(null);
    setConnectNote(null);

    try {
      const response = await fetch("/api/targets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoFullName: repo.trim(), deployedUrl: url.trim() }),
      });

      if (!response.ok) {
        setConnectError(await readError(response, "The target was not connected."));
        return;
      }

      const body = (await response.json()) as { note?: string };
      setConnectNote(
        body.note ?? "Connected. The deployed URL answered, so a run can start against it.",
      );
      setRepo("");
      setUrl("");
      router.refresh();
    } catch (cause) {
      setConnectError(
        cause instanceof Error
          ? `The target was not connected. ${cause.message}`
          : "The target was not connected.",
      );
    } finally {
      setConnecting(false);
    }
  }

  async function startRun(targetId: string): Promise<void> {
    if (startingId) return;
    setStartingId(targetId);
    setStartError(null);

    try {
      const response = await fetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetId }),
      });

      if (!response.ok) {
        setStartError(await readError(response, "The run did not start."));
        return;
      }

      const body = (await response.json()) as { run?: { id?: string } };
      if (body.run?.id) {
        router.push(`/app/runs/${body.run.id}`);
        return;
      }
      setStartError("The run was accepted but the server did not return an id.");
    } catch (cause) {
      setStartError(
        cause instanceof Error ? `The run did not start. ${cause.message}` : "The run did not start.",
      );
    } finally {
      setStartingId(null);
    }
  }

  return (
    <>
      <h2 className="sr-only">Connected targets</h2>

      {targets.length === 0 ? (
        <div className="quiet-panel">
          <Icon name="target" size={22} />
          <strong>No targets connected</strong>
          <span>
            Connect a repository and its deployed URL below. Nothing can be audited until one
            exists.
          </span>
        </div>
      ) : (
        <div className="record-list">
          {targets.map((target) => (
            <div className="record-row" key={target.id}>
              <span className="record-main">
                <strong>{target.repoFullName}</strong>
                <small>
                  {target.deployedUrl} · {target.runCount} run
                  {target.runCount === 1 ? "" : "s"} · connected {formatUtcDate(target.createdAt)}
                </small>
              </span>

              <button
                type="button"
                className="button primary"
                onClick={() => void startRun(target.id)}
                aria-disabled={startingId === target.id || undefined}
              >
                {startingId === target.id ? "Starting" : "Start run"}
                <Icon name="play" size={15} />
              </button>

              {target.lastRunId ? (
                <Link className="button secondary" href={`/app/runs/${target.lastRunId}`}>
                  Latest run
                  <Icon name="chevron-right" size={15} />
                </Link>
              ) : (
                <span className="muted" style={{ fontSize: 13 }}>
                  No runs yet
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      <p className="sr-only" aria-live="polite">
        {startingId
          ? "Starting a run. The deployed URL is being checked before anything is queued."
          : startError
            ? startError
            : ""}
      </p>

      {startError ? (
        <p className="approval-error" style={{ marginTop: 14 }}>
          <Icon name="warning" size={17} />
          <span>{startError}</span>
        </p>
      ) : null}

      <section className="section" aria-labelledby="add-target">
        <div className="section-heading">
          <div>
            <span className="eyebrow">New</span>
            <h2 id="add-target">Connect a target</h2>
            <p>
              The deployed URL is fetched before the target is stored. A non-2xx response is refused
              with a stated reason. Pull requests are opened later with your own GitHub token, and
              only after you approve the handoff.
            </p>
          </div>
        </div>

        <form
          className="card"
          style={{ display: "grid", gap: 16, maxWidth: 620 }}
          onSubmit={(event) => void connect(event)}
          noValidate
        >
          <div className="field">
            <label htmlFor={repoId}>Repository</label>
            <input
              id={repoId}
              name="repoFullName"
              type="text"
              value={repo}
              onChange={(event) => setRepo(event.target.value)}
              placeholder="owner/repository"
              autoComplete="off"
              required
              aria-invalid={connectError ? true : undefined}
              aria-describedby={connectError ? `${repoHelpId} ${errorId}` : repoHelpId}
            />
            <small id={repoHelpId}>
              In <code>owner/repository</code> form. Requires the <code>repo</code> scope on your
              GitHub account.
            </small>
          </div>

          <div className="field">
            <label htmlFor={urlId}>Deployed URL</label>
            <input
              id={urlId}
              name="deployedUrl"
              type="url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://example.com"
              autoComplete="url"
              required
              aria-invalid={connectError ? true : undefined}
              aria-describedby={connectError ? `${urlHelpId} ${errorId}` : urlHelpId}
            />
            <small id={urlHelpId}>
              Checked now, and again before every run. A non-2xx response stops the run with a
              stated reason.
            </small>
          </div>

          {connectError ? (
            <p className="approval-error" id={errorId}>
              <Icon name="warning" size={17} />
              <span>{connectError}</span>
            </p>
          ) : null}

          <div>
            <button
              className="button primary"
              type="submit"
              aria-disabled={connecting || undefined}
            >
              {connecting ? "Checking the deployment" : "Connect target"}
              <Icon name="arrow" size={15} />
            </button>
          </div>

          <p className="sr-only" aria-live="polite">
            {connecting
              ? "Fetching the deployed URL to check it answers."
              : connectError
                ? connectError
                : connectNote
                  ? connectNote
                  : ""}
          </p>

          {connectNote && !connectError ? (
            <p className="approval-note">
              <StatusLabel value="done" /> {connectNote}
            </p>
          ) : null}
        </form>
      </section>
    </>
  );
}
