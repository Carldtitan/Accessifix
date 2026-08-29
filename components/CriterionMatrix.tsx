import { StatusLabel } from "./StatusLabel";

export type CriterionLevel = "A" | "AA";
export type CriterionVerdict = "DECIDE" | "FLAG" | "BLOCKED";

export type CriterionRow = {
  id: string;
  name: string;
  level: CriterionLevel;
  baseline: CriterionVerdict;
  /** Null until the final audit has run (A8.1). */
  final: CriterionVerdict | null;
  findings: number;
};

/**
 * The fixed list of 55 WCAG 2.2 Level A and AA success criteria.
 * WCAG 2.2 removed 4.1.1 Parsing and added 2.4.11, 2.5.7, 2.5.8, 3.2.6,
 * 3.3.7 and 3.3.8. Scope is never reduced to a subset.
 */
export const WCAG_AA_CRITERIA: ReadonlyArray<{ id: string; name: string; level: CriterionLevel }> = [
  { id: "1.1.1", name: "Non-text Content", level: "A" },
  { id: "1.2.1", name: "Audio-only and Video-only (Prerecorded)", level: "A" },
  { id: "1.2.2", name: "Captions (Prerecorded)", level: "A" },
  { id: "1.2.3", name: "Audio Description or Media Alternative", level: "A" },
  { id: "1.2.4", name: "Captions (Live)", level: "AA" },
  { id: "1.2.5", name: "Audio Description (Prerecorded)", level: "AA" },
  { id: "1.3.1", name: "Info and Relationships", level: "A" },
  { id: "1.3.2", name: "Meaningful Sequence", level: "A" },
  { id: "1.3.3", name: "Sensory Characteristics", level: "A" },
  { id: "1.3.4", name: "Orientation", level: "AA" },
  { id: "1.3.5", name: "Identify Input Purpose", level: "AA" },
  { id: "1.4.1", name: "Use of Color", level: "A" },
  { id: "1.4.2", name: "Audio Control", level: "A" },
  { id: "1.4.3", name: "Contrast (Minimum)", level: "AA" },
  { id: "1.4.4", name: "Resize Text", level: "AA" },
  { id: "1.4.5", name: "Images of Text", level: "AA" },
  { id: "1.4.10", name: "Reflow", level: "AA" },
  { id: "1.4.11", name: "Non-text Contrast", level: "AA" },
  { id: "1.4.12", name: "Text Spacing", level: "AA" },
  { id: "1.4.13", name: "Content on Hover or Focus", level: "AA" },
  { id: "2.1.1", name: "Keyboard", level: "A" },
  { id: "2.1.2", name: "No Keyboard Trap", level: "A" },
  { id: "2.1.4", name: "Character Key Shortcuts", level: "A" },
  { id: "2.2.1", name: "Timing Adjustable", level: "A" },
  { id: "2.2.2", name: "Pause, Stop, Hide", level: "A" },
  { id: "2.3.1", name: "Three Flashes or Below Threshold", level: "A" },
  { id: "2.4.1", name: "Bypass Blocks", level: "A" },
  { id: "2.4.2", name: "Page Titled", level: "A" },
  { id: "2.4.3", name: "Focus Order", level: "A" },
  { id: "2.4.4", name: "Link Purpose (In Context)", level: "A" },
  { id: "2.4.5", name: "Multiple Ways", level: "AA" },
  { id: "2.4.6", name: "Headings and Labels", level: "AA" },
  { id: "2.4.7", name: "Focus Visible", level: "AA" },
  { id: "2.4.11", name: "Focus Not Obscured (Minimum)", level: "AA" },
  { id: "2.5.1", name: "Pointer Gestures", level: "A" },
  { id: "2.5.2", name: "Pointer Cancellation", level: "A" },
  { id: "2.5.3", name: "Label in Name", level: "A" },
  { id: "2.5.4", name: "Motion Actuation", level: "A" },
  { id: "2.5.7", name: "Dragging Movements", level: "AA" },
  { id: "2.5.8", name: "Target Size (Minimum)", level: "AA" },
  { id: "3.1.1", name: "Language of Page", level: "A" },
  { id: "3.1.2", name: "Language of Parts", level: "AA" },
  { id: "3.2.1", name: "On Focus", level: "A" },
  { id: "3.2.2", name: "On Input", level: "A" },
  { id: "3.2.3", name: "Consistent Navigation", level: "AA" },
  { id: "3.2.4", name: "Consistent Identification", level: "AA" },
  { id: "3.2.6", name: "Consistent Help", level: "A" },
  { id: "3.3.1", name: "Error Identification", level: "A" },
  { id: "3.3.2", name: "Labels or Instructions", level: "A" },
  { id: "3.3.3", name: "Error Suggestion", level: "AA" },
  { id: "3.3.4", name: "Error Prevention (Legal, Financial, Data)", level: "AA" },
  { id: "3.3.7", name: "Redundant Entry", level: "A" },
  { id: "3.3.8", name: "Accessible Authentication (Minimum)", level: "AA" },
  { id: "4.1.2", name: "Name, Role, Value", level: "A" },
  { id: "4.1.3", name: "Status Messages", level: "AA" },
];

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
