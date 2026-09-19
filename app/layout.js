/**
 * Root layout — minimal on purpose.
 *
 * BACKEND BRANCH: this file and app/page.js exist only so `next dev` and
 * `next build` succeed and the API routes are reachable. They are placeholders
 * for the frontend branches (feat/director, feat/surgeon, feat/polish) to
 * replace. No UI work belongs on this branch.
 */

import "./globals.css";

export const metadata = {
  title: "Fatigue-aware surgical scheduling",
  description:
    "Scheduling decision support that assigns surgeries on measured recovery state and real case complexity. Synthetic demo data.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
