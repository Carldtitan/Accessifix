import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "AccessiFix — accessibility auditing that walks the state machine",
    template: "%s · AccessiFix",
  },
  description:
    "AccessiFix drives a site through its state transitions, reads the accessibility tree on both sides of every interaction, writes the fix, proves the tests still pass, and opens a pull request.",
  applicationName: "AccessiFix",
  openGraph: {
    title: "AccessiFix",
    description:
      "Every accessibility tool checks a page standing still. AccessiFix walks the state machine.",
    type: "website",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Never block pinch zoom (WCAG 1.4.4).
  maximumScale: 5,
  userScalable: true,
  themeColor: "#f2e9dc",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main-content">
          Skip to main content
        </a>
        {children}
      </body>
    </html>
  );
}
