"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { BrandMark, Icon, type IconName } from "./Icon";

const navItems: ReadonlyArray<{ label: string; href: string; icon: IconName }> = [
  { label: "Overview", href: "/app", icon: "home" },
  { label: "Runs", href: "/app/runs", icon: "activity" },
  { label: "Findings", href: "/app/findings", icon: "warning" },
  { label: "Targets", href: "/app/targets", icon: "target" },
  { label: "Settings", href: "/app/settings", icon: "settings" },
];

export type ShellUser = { name: string; email?: string };

const MOBILE_QUERY = "(max-width: 900px)";

/**
 * Sidebar shell.
 *
 * Accessibility contract:
 * - The active link carries `aria-current="page"`; the tint is secondary.
 * - The mobile drawer is a real dialog: `aria-expanded` on the trigger tracks
 *   the actual open state, focus moves into the drawer, Tab is trapped,
 *   Escape closes it, focus returns to the trigger, and the closed drawer is
 *   `inert` so it never receives tab stops behind the scrim.
 * - The desktop sidebar is a plain landmark with no dialog semantics.
 */
export function AppShell({
  children,
  user = { name: "Demo Reviewer", email: "reviewer@example.com" },
  targetName = "Clearway",
}: {
  children: React.ReactNode;
  user?: ShellUser;
  targetName?: string;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const pathname = usePathname();
  const sidebarRef = useRef<HTMLElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const closeMenu = useCallback(() => setMenuOpen(false), []);

  useEffect(() => {
    const query = window.matchMedia(MOBILE_QUERY);
    const sync = () => {
      setIsMobile(query.matches);
      // Leaving mobile width must not strand the drawer in its open state.
      if (!query.matches) setMenuOpen(false);
    };
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  // Dialog behaviour: initial focus, focus trap, Escape, focus restoration.
  useEffect(() => {
    if (!menuOpen || !isMobile) return;
    const panel = sidebarRef.current;
    const trigger = triggerRef.current;
    const focusable = () =>
      Array.from(panel?.querySelectorAll<HTMLElement>('a[href], button:not([disabled])') ?? []);

    focusable()[0]?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setMenuOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      trigger?.focus();
    };
  }, [menuOpen, isMobile]);

  const initials = user.name
    .split(/\s+/)
    .map((part) => part[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();

  const drawerIsHidden = isMobile && !menuOpen;

  return (
    <div className="app-shell">
      <aside
        ref={sidebarRef}
        id="app-nav"
        className={`sidebar${menuOpen ? " is-open" : ""}`}
        aria-label="Main"
        role={isMobile ? "dialog" : undefined}
        aria-modal={isMobile && menuOpen ? true : undefined}
        inert={drawerIsHidden}
      >
        <div className="brand-row">
          <Link className="brand" href="/">
            <BrandMark />
            <span>AccessiFix</span>
          </Link>
          <button type="button" className="icon-button sidebar-close" onClick={closeMenu}>
            <Icon name="close" />
            <span className="sr-only">Close navigation</span>
          </button>
        </div>

        <p className="sidebar-context">
          <small>Target</small>
          <strong>{targetName}</strong>
        </p>

        <nav className="side-nav" aria-label="Sections">
          {navItems.map((item) => {
            const active = item.href === "/app" ? pathname === "/app" : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                className="nav-item"
                href={item.href}
                aria-current={active ? "page" : undefined}
                onClick={closeMenu}
              >
                <Icon name={item.icon} />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="sidebar-bottom">
          <Link className="account-link" href="/app/settings" onClick={closeMenu}>
            <span className="avatar" aria-hidden="true">
              {initials}
            </span>
            <span className="account-copy">
              <strong>{user.name}</strong>
              <span>{user.email ?? "GitHub account"}</span>
            </span>
            <Icon name="chevron-right" />
          </Link>
        </div>
      </aside>

      {isMobile && menuOpen ? (
        <button type="button" className="sidebar-scrim" onClick={closeMenu} tabIndex={-1}>
          <span className="sr-only">Close navigation</span>
        </button>
      ) : null}

      <div className="app-main">
        <header className="mobile-header">
          <button
            ref={triggerRef}
            type="button"
            className="icon-button"
            aria-expanded={menuOpen}
            aria-controls="app-nav"
            onClick={() => setMenuOpen((open) => !open)}
          >
            <Icon name="menu" />
            <span className="sr-only">Navigation</span>
          </button>
          <Link className="brand" href="/">
            <BrandMark size={27} />
            <span>AccessiFix</span>
          </Link>
          <span />
        </header>
        {children}
      </div>
    </div>
  );
}
