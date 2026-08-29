import { FindingCard } from "./FindingCard";
import { Icon } from "./Icon";
import { StatusLabel } from "./StatusLabel";
import type { CriterionGroup } from "./run-data";

/**
 * Findings grouped by the success criterion they cite.
 *
 * The ledger's rule is that no finding exists without a numbered criterion, so
 * the criterion is the natural heading and this is the natural grouping.
 *
 * Accessibility contract:
 * - One heading per group at the level the caller asks for, so the page keeps a
 *   single unbroken heading outline.
 * - Each group is a real list, so assistive technology reports how many
 *   findings sit under a criterion before reading them.
 * - Severity and verdict are words in a StatusLabel, never tint alone.
 * - Nothing here is a live region: the caller owns the announcement, so a run
 *   that gains findings announces once rather than once per group.
 */
export function FindingsByCriterion({
  groups,
  headingLevel = 3,
  emptyMessage = "No findings recorded against this run yet.",
}: {
  groups: ReadonlyArray<CriterionGroup>;
  /** 2 through 4. Must continue the caller's outline rather than restart it. */
  headingLevel?: 2 | 3 | 4;
  emptyMessage?: string;
}) {
  if (groups.length === 0) {
    return (
      <div className="quiet-panel">
        <Icon name="check" size={22} />
        <strong>No findings</strong>
        <span>{emptyMessage}</span>
      </div>
    );
  }

  const Heading = `h${headingLevel}` as "h2" | "h3" | "h4";

  return (
    <div style={{ display: "grid", gap: 22 }}>
      {groups.map((group) => {
        const headingId = `criterion-group-${group.criterion.replace(/\./g, "-")}`;
        const count = group.findings.length;

        return (
          <section key={group.criterion} aria-labelledby={headingId}>
            <div className="section-heading" style={{ marginBottom: 10 }}>
              <div>
                <span className="criterion-badge">
                  <Icon name="check" size={14} />
                  <code>SC {group.criterion}</code>
                </span>
                <Heading id={headingId} style={{ marginTop: 6 }}>
                  {group.name}
                </Heading>
                <p>
                  <span className="level-tag">Level {group.level}</span>{" "}
                  <StatusLabel value={group.verdict} />{" "}
                  <StatusLabel value={group.severity} prefix="Worst severity:" />
                </p>
              </div>
              <span className="section-count">{count}</span>
            </div>

            <ul
              className="finding-stack"
              style={{ listStyle: "none", margin: 0, padding: 0 }}
              aria-label={`${count} finding${count === 1 ? "" : "s"} against success criterion ${group.criterion}`}
            >
              {group.findings.map((finding) => (
                <li key={finding.id}>
                  <FindingCard finding={finding} />
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
