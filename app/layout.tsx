import type { Metadata } from "next";
import Link from "next/link";

import "./globals.css";

export const metadata: Metadata = {
  title: "Anduin Investigator",
  description: "Source-backed project history from Jira, email, and Slack.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <header className="border-b border-line bg-surface/80 backdrop-blur">
          <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
            <Link href="/" className="flex items-baseline gap-2">
              <span className="text-sm font-semibold tracking-tight text-ink">Anduin Investigator</span>
              <span className="hidden text-xs text-muted sm:inline">
                source-backed project history
              </span>
            </Link>
            <span className="pill pill-neutral">layer 1 · v1.0.0</span>
          </div>
        </header>
        <main>{children}</main>
        <footer className="mx-auto w-full max-w-6xl px-4 py-8 text-xs text-muted sm:px-6">
          Every claim links to an event and a quote verified in code. Unknowns are listed as gaps,
          never guessed.
        </footer>
      </body>
    </html>
  );
}
