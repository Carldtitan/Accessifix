"use client";

import { useId, useRef, useState } from "react";
import { FindingCard, type Finding } from "./FindingCard";

type TabKey = "all" | "severe" | "human" | "resolved";

const tabs: ReadonlyArray<{ key: TabKey; label: string; match: (finding: Finding) => boolean }> = [
  { key: "all", label: "All findings", match: () => true },
  {
    key: "severe",
    label: "Critical and serious",
    match: (finding) => finding.severity === "critical" || finding.severity === "serious",
  },
  { key: "human", label: "Human queue", match: (finding) => finding.verdict === "FLAG" },
  {
    key: "resolved",
    label: "Fixed or verified",
    match: (finding) => finding.status === "fixed" || finding.status === "verified",
  },
];

/**
 * Findings filter, built as the WAI-ARIA tabs pattern.
 *
 * Accessibility contract:
 * - `role="tablist"` with one `role="tab"` per filter. `aria-selected` tracks
 *   the real selection on every change; `aria-controls` points at the panel.
 * - Roving tabindex: exactly one tab is in the tab order. Left/Right, Home and
 *   End move between tabs and activate automatically, per the pattern.
 * - The panel is `role="tabpanel"` with `tabIndex={0}` and `aria-labelledby`
 *   pointing back at its tab.
 * - Selection is signalled by weight and a raised surface as well as tint.
 */
export function FindingsTabs({ findings }: { findings: ReadonlyArray<Finding> }) {
  const [active, setActive] = useState<TabKey>("all");
  const baseId = useId();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const activeIndex = tabs.findIndex((tab) => tab.key === active);
  const activeTab = tabs[activeIndex] ?? tabs[0];
  const visible = findings.filter(activeTab.match);

  function selectAt(index: number) {
    const next = tabs[(index + tabs.length) % tabs.length];
    setActive(next.key);
    tabRefs.current[(index + tabs.length) % tabs.length]?.focus();
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    switch (event.key) {
      case "ArrowRight":
        event.preventDefault();
        selectAt(activeIndex + 1);
        break;
      case "ArrowLeft":
        event.preventDefault();
        selectAt(activeIndex - 1);
        break;
      case "Home":
        event.preventDefault();
        selectAt(0);
        break;
      case "End":
        event.preventDefault();
        selectAt(tabs.length - 1);
        break;
      default:
        break;
    }
  }

  return (
    <>
      <div className="tablist" role="tablist" aria-label="Filter findings" onKeyDown={onKeyDown}>
        {tabs.map((tab, index) => {
          const selected = tab.key === active;
          const count = findings.filter(tab.match).length;
          return (
            <button
              key={tab.key}
              ref={(node) => {
                tabRefs.current[index] = node;
              }}
              type="button"
              className="tab"
              role="tab"
              id={`${baseId}-tab-${tab.key}`}
              aria-selected={selected}
              aria-controls={`${baseId}-panel`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setActive(tab.key)}
            >
              {tab.label}
              <span className="tab-count">{count}</span>
            </button>
          );
        })}
      </div>

      <div
        className="tabpanel"
        role="tabpanel"
        id={`${baseId}-panel`}
        aria-labelledby={`${baseId}-tab-${active}`}
        tabIndex={0}
      >
        {visible.length === 0 ? (
          <div className="quiet-panel">
            <strong>Nothing in this filter</strong>
            <span>No findings match {activeTab.label.toLowerCase()}.</span>
          </div>
        ) : (
          <div className="finding-stack">
            {visible.map((finding) => (
              <FindingCard key={finding.id} finding={finding} />
            ))}
          </div>
        )}
      </div>

      <p className="sr-only" aria-live="polite">
        {`${visible.length} finding${visible.length === 1 ? "" : "s"} shown for ${activeTab.label}.`}
      </p>
    </>
  );
}
