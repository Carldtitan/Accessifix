import type { ReactNode } from "react";

/**
 * Inline line-icon set for AccessiFix.
 *
 * Accessibility contract:
 * - Decorative by default: `aria-hidden="true"` and `focusable="false"`, so the
 *   icon never adds a stray node to the accessibility tree. The label always
 *   comes from adjacent text or the control's own accessible name.
 * - Pass `title` ONLY when the icon is the sole carrier of meaning. That
 *   switches it to `role="img"` with an `<title>` element.
 */
export type IconName =
  | "activity"
  | "arrow"
  | "back"
  | "check"
  | "chevron"
  | "chevron-right"
  | "close"
  | "code"
  | "external"
  | "eye"
  | "folder"
  | "github"
  | "home"
  | "image"
  | "menu"
  | "play"
  | "settings"
  | "sparkle"
  | "target"
  | "tree"
  | "warning";

const paths: Record<IconName, ReactNode> = {
  activity: <path d="M3 12h3l2.2-5 3.5 10 2.5-6H21" />,
  arrow: <path d="M5 12h14M14 7l5 5-5 5" />,
  back: <path d="m15 18-6-6 6-6" />,
  check: <path d="m5 12 4 4 10-10" />,
  chevron: <path d="m8 10 4 4 4-4" />,
  "chevron-right": <path d="m10 7 5 5-5 5" />,
  close: <path d="m7 7 10 10M17 7 7 17" />,
  code: <path d="m9 18-6-6 6-6M15 6l6 6-6 6" />,
  external: <path d="M14 5h5v5M19 5l-8 8M18 13v6H5V6h6" />,
  eye: (
    <>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="2.8" />
    </>
  ),
  folder: <path d="M3.5 6.5h6l2 2H21v10H3.5z" />,
  github: (
    <path d="M15 22v-3.9c.04-1-.36-1.8-.8-2.2 2.6-.3 5.3-1.3 5.3-5.8 0-1.3-.5-2.3-1.2-3.1.1-.3.5-1.5-.1-3.1 0 0-1-.3-3.2 1.2A11 11 0 0 0 12 4.7c-1 0-2 .1-2.9.4C6.9 3.6 6 4 6 4c-.7 1.6-.3 2.8-.2 3.1-.8.8-1.2 1.8-1.2 3.1 0 4.5 2.7 5.5 5.3 5.8-.4.4-.7 1-.8 1.8-.8.4-2.8 1-4-1.2-.8-1.4-2-1.5-2-1.5M9 22v-3.7" />
  ),
  home: <path d="m3 11 9-8 9 8v9h-6v-6H9v6H3z" />,
  image: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="2.5" />
      <path d="m5 17 4.5-4.5 3 3L16 12l3 3" />
      <circle cx="9" cy="9.5" r="1.3" />
    </>
  ),
  menu: <path d="M5 7h14M5 12h14M5 17h14" />,
  play: <path d="m9 6 9 6-9 6z" />,
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" />
    </>
  ),
  sparkle: <path d="m12 2.5 1.7 5.3 5.3 1.7-5.3 1.7L12 16.5l-1.7-5.3L5 9.5l5.3-1.7ZM18.4 15.4l.7 2.2 2.2.7-2.2.7-.7 2.2-.7-2.2-2.2-.7 2.2-.7Z" />,
  target: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="12" cy="12" r="0.9" fill="currentColor" stroke="none" />
    </>
  ),
  tree: (
    <>
      <path d="M6 4v12a2 2 0 0 0 2 2h3M6 10h5" />
      <rect x="11" y="7.5" width="7" height="5" rx="1.3" />
      <rect x="11" y="15.5" width="7" height="5" rx="1.3" />
      <rect x="3.2" y="2" width="5.6" height="4" rx="1.3" />
    </>
  ),
  warning: (
    <>
      <path d="M12 3 2.8 20h18.4L12 3Z" />
      <path d="M12 9v5M12 17.4h.01" />
    </>
  ),
};

export function Icon({
  name,
  size = 18,
  className,
  title,
}: {
  name: IconName;
  size?: number;
  className?: string;
  /** Supply only when the icon alone must convey meaning. */
  title?: string;
}) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
    >
      {title ? <title>{title}</title> : null}
      {paths[name]}
    </svg>
  );
}

export function BrandMark({ size = 31 }: { size?: number }) {
  return (
    <span className="brand-mark" style={{ width: size, height: size }}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" focusable="false" aria-hidden="true">
        <path d="M12 3v6M12 9 7 13M12 9l5 4" />
        <circle cx="12" cy="3.6" r="1.5" fill="currentColor" stroke="none" />
        <path d="m4.5 17.5 2.6 2.6L12 14.6" />
        <path d="M15.5 18.5h4.6" />
      </svg>
    </span>
  );
}
