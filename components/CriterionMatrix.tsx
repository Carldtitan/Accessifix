import { StatusLabel } from "./StatusLabel";

export type CriterionLevel = "A" | "AA";
export type CriterionVerdict = "DECIDE" | "FLAG" | "BLOCKED";

/**
 * What a matrix cell can say about a criterion.
 *
 * `DECIDE` / `FLAG` / `BLOCKED` are the criterion's routing verdict, fixed in
 * lib/db/criteria.ts. The lower-case four are the *outcome* a run scored for
 * it, from lib/pipeline/score.ts. Both are rendered as words, never as tint
 * alone.
 */
export type CriterionCell =
  | CriterionVerdict
  | "passing"
  | "failing"
  | "flagged"
  | "blocked";

export type CriterionRow = {
  id: string;
  name: string;
  level: CriterionLevel;
  baseline: CriterionCell;
  /** Null until the final audit has run (A8.1). */
  final: CriterionCell | null;
  findings: number;
};

/**
 * CriterionMatrix — one row per criterion, baseline against final.
 *
 * Accessibility contract:
 * - A real table with a caption, column scopes and a row header per criterion,
 *   so a screen reader can read "1.4.3, Baseline, Flag".
 * - The table scrolls inside its own container. The container is a labelled
 *   region with `tabIndex={0}` so keyboard-only users can scroll it
 *   (WCAG 2.1.1). The page itself never scrolls sideways.
 * - Verdicts are words, not colours.
 */
export function CriterionMatrix({
  rows,
  id = "criterion-matrix",
  caption = "Every WCAG 2.2 Level A and AA success criterion, with its baseline verdict, its final verdict, and the number of findings recorded against it.",
}: {
  rows: ReadonlyArray<CriterionRow>;
  id?: string;
  caption?: string;
}) {
  const captionId = `${id}-caption`;

  return (
    <div className="criterion-matrix">
      <div
        className="criterion-scroll"
        role="region"
        aria-labelledby={captionId}
        tabIndex={0}
      >
        <table>
          <caption id={captionId}>
            {caption} {rows.length} criteria in scope.
          </caption>
          <thead>
            <tr>
              <th scope="col">Criterion</th>
              <th scope="col">Name</th>
              <th scope="col">Level</th>
              <th scope="col">Baseline</th>
              <th scope="col">Final</th>
              <th scope="col" className="col-count">
                Findings
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <th scope="row">{row.id}</th>
                <td className="col-name">{row.name}</td>
                <td>
                  <span className="level-tag">{row.level}</span>
                </td>
                <td>
                  <StatusLabel value={row.baseline} />
                </td>
                <td>
                  {row.final ? (
                    <StatusLabel value={row.final} />
                  ) : (
                    <span className="muted">Not run yet</span>
                  )}
                </td>
                <td className="col-count">
                  {row.findings === 0 ? <span className="zero">0</span> : row.findings}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
