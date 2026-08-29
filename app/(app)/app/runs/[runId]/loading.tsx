/**
 * Shown while the run is read from the ledger.
 *
 * A sentence rather than a spinner: it names what is being fetched, so a slow
 * read reads as a slow read and not as a hang. `role="status"` is polite and
 * moves no focus.
 */
export default function RunDetailLoading() {
  return (
    <main id="main-content" className="dashboard-page">
      <div className="page-header">
        <div>
          <span className="eyebrow">Investigation</span>
          <h1>Opening the run</h1>
        </div>
      </div>

      <p className="quiet-panel" role="status">
        <strong>Reading this run from the ledger</strong>
        <span>
          Its findings, jobs, patches and event log are being fetched. The live stream connects once
          they are on screen.
        </span>
      </p>
    </main>
  );
}
