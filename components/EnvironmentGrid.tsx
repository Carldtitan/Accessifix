import { Icon } from "./Icon";
import { StatusLabel, type StatusValue } from "./StatusLabel";

export type EnvironmentState = "live" | "done" | "queued" | "failed";

export type PathTemplate = "Toggle" | "Dialog" | "Form" | "Crawl" | "Vision" | "Media";

export type BrowserEnvironment = {
  id: string;
  /** Engine and viewport, e.g. "Chromium 1280x720". */
  engine: string;
  /** The interaction path under test, in plain language. */
  pathLabel: string;
  pathTemplate: PathTemplate;
  /** WCAG criterion this path is exercising, when there is exactly one. */
  criterion?: string;
  state: EnvironmentState;
  /** Latest captured frame. Omit to show the placeholder frame. */
  screenshotUrl?: string;
  /** Relative freshness, e.g. "2s ago". */
  capturedAt?: string;
  findings?: number;
};

const badgeText: Record<EnvironmentState, string> = {
  live: "Live",
  done: "Done",
  queued: "Queued",
  failed: "Failed",
};

const badgeClass: Record<EnvironmentState, string> = {
  live: "badge-live",
  done: "badge-done",
  queued: "badge-queued",
  failed: "badge-failed",
};

const statusValue: Record<EnvironmentState, StatusValue> = {
  live: "running",
  done: "done",
  queued: "queued",
  failed: "failed",
};

function announce(environments: ReadonlyArray<BrowserEnvironment>): string {
  const count = (state: EnvironmentState) => environments.filter((item) => item.state === state).length;
  const parts = [
    `${count("live")} running`,
    `${count("done")} finished`,
    `${count("queued")} queued`,
  ];
  const failed = count("failed");
  if (failed > 0) parts.push(`${failed} failed`);
  return `Browser environments: ${parts.join(", ")}.`;
}

/**
 * EnvironmentGrid — requirement A11.1. The parallel browser fleet.
 *
 * Accessibility contract:
 * - A real list, so assistive technology reports how many environments exist.
 * - Every card states its status in text as well as tint.
 * - Status changes are announced once, through a single polite live region.
 *   Focus is never moved (A11.6 / WCAG 3.2.x).
 * - Placeholder frames are labelled as placeholders, not passed off as capture.
 */
export function EnvironmentGrid({
  environments,
  emptyMessage = "The environment plan has not been dispatched yet.",
}: {
  environments: ReadonlyArray<BrowserEnvironment>;
  emptyMessage?: string;
}) {
  if (environments.length === 0) {
    return (
      <div className="quiet-panel">
        <Icon name="activity" size={22} />
        <strong>No environments running</strong>
        <span>{emptyMessage}</span>
      </div>
    );
  }

  return (
    <>
      <ul className="environment-grid">
        {environments.map((environment) => (
          <li key={environment.id} className={`environment-card${environment.state === "failed" ? " is-failed" : ""}`}>
            <div className="environment-screen">
              {environment.screenshotUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={environment.screenshotUrl}
                  alt={`Latest captured frame from ${environment.engine}, testing ${environment.pathLabel}`}
                  loading="lazy"
                  decoding="async"
                />
              ) : (
                <>
                  <Icon name="image" size={24} className="placeholder-mark" />
                  <span className="placeholder-text">
                    {environment.state === "queued" ? "Waiting for a sandbox" : "No frame captured yet"}
                  </span>
                </>
              )}
              <div className="environment-badges">
                <span className={badgeClass[environment.state]}>{badgeText[environment.state]}</span>
                <span>{environment.pathTemplate}</span>
              </div>
            </div>

            <div className="environment-body">
              <span className="environment-path">
                <strong>{environment.pathLabel}</strong>
                <small>
                  <code>{environment.engine}</code>
                  {environment.criterion ? ` · SC ${environment.criterion}` : null}
                </small>
              </span>

              <span className="environment-foot">
                <StatusLabel value={statusValue[environment.state]} />
                <small>
                  {environment.findings !== undefined
                    ? `${environment.findings} finding${environment.findings === 1 ? "" : "s"}`
                    : null}
                  {environment.findings !== undefined && environment.capturedAt ? " · " : null}
                  {environment.capturedAt}
                </small>
              </span>
            </div>
          </li>
        ))}
      </ul>

      <p className="sr-only" aria-live="polite">
        {announce(environments)}
      </p>
    </>
  );
}
