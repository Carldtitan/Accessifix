export type Patch = {
  id: string;
  /** Repository-relative file path. */
  path: string;
  /** Criterion numbers this patch addresses (A5.5). */
  covers: ReadonlyArray<string>;
  /** Unified diff body, whitespace preserved. */
  diff: string;
};

function lineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) return "line line-meta";
  if (line.startsWith("+")) return "line line-add";
  if (line.startsWith("-")) return "line line-del";
  return "line";
}

/**
 * DiffCard — proposed patches shown as diffs (A11.4).
 *
 * Accessibility contract:
 * - The leading + and - characters are kept, so added and removed lines are
 *   distinguishable without colour (WCAG 1.4.1).
 * - The code body scrolls inside itself, horizontally as well as vertically,
 *   and is a labelled region with `tabIndex={0}` so it can be scrolled from
 *   the keyboard. Diffs are never wrapped.
 */
export function DiffCard({ patch }: { patch: Patch }) {
  const lines = patch.diff.replace(/\n$/, "").split("\n");

  return (
    <article className="diff-card">
      <header>
        <span>{patch.path}</span>
        <span className="diff-covers">
          {patch.covers.length > 0 ? `Covers SC ${patch.covers.join(", ")}` : "No criteria recorded"}
        </span>
      </header>
      <div className="diff-body" tabIndex={0} role="region" aria-label={`Proposed diff for ${patch.path}`}>
        <pre>
          <code>
            {lines.map((line, index) => (
              <span key={`${patch.id}-${index}`} className={lineClass(line)}>
                {line === "" ? " " : line}
                {"\n"}
              </span>
            ))}
          </code>
        </pre>
      </div>
    </article>
  );
}

export function DiffStack({ patches }: { patches: ReadonlyArray<Patch> }) {
  if (patches.length === 0) {
    return <div className="quiet-panel">No patches proposed yet.</div>;
  }
  return (
    <div className="diff-stack">
      {patches.map((patch) => (
        <DiffCard key={patch.id} patch={patch} />
      ))}
    </div>
  );
}
