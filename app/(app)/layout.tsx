import { AppShell } from "@/components/AppShell";
import { SAMPLE_TARGET } from "@/components/sample-data";

/**
 * Signed-in shell. Every route under /app renders inside the sidebar.
 *
 * PLACEHOLDER: the user and target are static sample values. When the session
 * and the ledger exist, read them here and pass them down.
 */
export default function AppLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <AppShell
      user={{ name: "Demo Reviewer", email: "reviewer@example.com" }}
      targetName={SAMPLE_TARGET.name}
    >
      {children}
    </AppShell>
  );
}
