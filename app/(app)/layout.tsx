import { AppShell } from "@/components/AppShell";

import { listTargets, sessionUser } from "./_data";

/**
 * Signed-in shell. Every route under /app renders inside the sidebar.
 *
 * The session is real: an unauthenticated visitor is sent to GitHub rather than
 * shown a demo identity. The redirect itself is left to the page, not taken
 * here — the layout does not know which route was asked for, and redirecting
 * from here would send every deep link to /app after sign-in. A shared run URL
 * has to survive the round trip, so the page redirects with its own
 * `callbackUrl` and this renders nothing in the meantime.
 *
 * The sidebar's target is the user's most recently connected one, or an honest
 * "none" when they have not connected any.
 */
export const dynamic = "force-dynamic";

export default async function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const user = await sessionUser();

  // The page below is already redirecting to GitHub. Rendering a shell around
  // a redirect would only flash an identity nobody is signed in as.
  if (!user) return <>{children}</>;

  const targets = await listTargets(user.id);

  return (
    <AppShell
      user={{ name: user.name, ...(user.email ? { email: user.email } : {}) }}
      targetName={targets[0]?.repoFullName ?? "None connected"}
    >
      {children}
    </AppShell>
  );
}
