import type { AuditAgent } from "./FindingCard";

/** Which harness capability produced the event (A13.9). */
export type HarnessCapability = "sandbox" | "subagent" | "approval" | "skill" | "model" | "ledger";

export type TimelineEvent = {
  id: string;
  /** The agent that produced the event. "APP" is the dispatcher itself. */
  agent: AuditAgent | "APP";
  summary: string;
  /** ISO 8601 timestamp. */
  timestamp: string;
  capability?: HarnessCapability;
  detail?: string;
};

const capabilityLabels: Record<HarnessCapability, string> = {
  sandbox: "Sandbox",
  subagent: "Subagent",
  approval: "Approval",
  skill: "Skill",
  model: "Model",
  ledger: "Ledger",
};

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  // Fixed locale and zone so server and client render identical text.
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "UTC",
  }).format(date);
}

/**
 * AgentTimeline — requirement A11.3, plus A13.9.
 *
 * Accessibility contract:
 * - An ordered list, so the chronology survives linearisation.
 * - Every event names its agent in text; the tag is not colour-coded state.
 * - Timestamps use <time datetime> with a fixed locale and UTC, which also
 *   keeps server and client markup identical.
 * - The connector rail is a CSS pseudo-element, invisible to assistive tech.
 */
export function AgentTimeline({
  events,
  emptyMessage = "No agent events recorded for this run yet.",
}: {
  events: ReadonlyArray<TimelineEvent>;
  emptyMessage?: string;
}) {
  if (events.length === 0) {
    return <div className="quiet-panel">{emptyMessage}</div>;
  }

  return (
    <ol className="timeline-list">
      {events.map((event) => (
        <li key={event.id}>
          <i aria-hidden="true" />
          <span className="timeline-entry">
            <strong>{event.summary}</strong>
            {event.detail ? <span className="muted">{event.detail}</span> : null}
            <span className="timeline-meta">
              <span className="agent-tag">{event.agent}</span>
              {event.capability ? (
                <span className="capability-tag">{capabilityLabels[event.capability]}</span>
              ) : null}
              <time dateTime={event.timestamp}>{formatTime(event.timestamp)} UTC</time>
            </span>
          </span>
        </li>
      ))}
    </ol>
  );
}
