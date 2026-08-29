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
 *   the real selection on every change.
 * - One `role="tabpanel"` per tab, not one shared panel. Each tab's
 *   `aria-controls` names *its own* panel, and each panel is `aria-labelledby`
 *   *its own* tab, so the relationship resolves correctly for every tab rather
 *   than only for the selected one. Unselected panels stay in the DOM and are
 *   closed with the `hidden` attribute, which takes them out of the
 *   accessibility tree and out of the tab order.
 * - Roving tabindex: exactly one tab is in the tab order. Left/Right, Home and
 *   End move between tabs and activate automatically, per the pattern.
 * - Selection is signalled by weight and a raised surface as well as tint.
 */
export function FindingsTabs({ findings }: { findings: ReadonlyArray<Finding> }) {
  const [active, setActive] = useState<TabKey>("all");
  const baseId = useId();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const tabId = (key: TabKey) => `${baseId}-tab-${key}`;
  const panelId = (key: TabKey) => `${baseId}-panel-${key}`;

  const activeIndex = Math.max(
    0,
    tabs.findIndex((tab) => tab.key === active),
  );
  const activeTab = tabs[activeIndex];
  // One pass, reused by the count on each tab and by the panel beneath it.
  const matches = tabs.map((tab) => findings.filter(tab.match));
  const visibleCount = matches[activeIndex].length;

  function selectAt(index: number) {
    const wrapped = (index + tabs.length) % tabs.length;
    setActive(tabs[wrapped].key);
    tabRefs.current[wrapped]?.focus();
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
          return (
            <button
              key={tab.key}
              ref={(node) => {
                tabRefs.current[index] = node;
              }}
              type="button"
              className="tab"
              role="tab"
              id={tabId(tab.key)}
              aria-selected={selected}
              aria-controls={panelId(tab.key)}
              tabIndex={selected ? 0 : -1}
              onClick={() => setActive(tab.key)}
            >
              {tab.label}
              <span className="tab-count">{matches[index].length}</span>
            </button>
          );
        })}
      </div>

      {tabs.map((tab, index) => {
        const visible = matches[index];
        return (
          <div
            key={tab.key}
            className="tabpanel"
            role="tabpanel"
            id={panelId(tab.key)}
            aria-labelledby={tabId(tab.key)}
            tabIndex={0}
            hidden={tab.key !== active}
          >
            {visible.length === 0 ? (
              <div className="quiet-panel">
                <strong>Nothing in this filter</strong>
                <span>No findings match {tab.label.toLowerCase()}.</span>
              </div>
            ) : (
              <div className="finding-stack">
                {visible.map((finding) => (
                  <FindingCard key={finding.id} finding={finding} />
                ))}
              </div>
            )}
          </div>
        );
      })}

      <p className="sr-only" aria-live="polite">
        {`${visibleCount} finding${visibleCount === 1 ? "" : "s"} shown for ${activeTab.label}.`}
      </p>
    </>
  );
}
