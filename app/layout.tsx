import type { Metadata } from "next";
import Link from "next/link";
import { Inter, JetBrains_Mono, Newsreader } from "next/font/google";

import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-inter",
});

const newsreader = Newsreader({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-newsreader",
});

const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-jetbrains",
});

export const metadata: Metadata = {
  title: "Anduin Investigator",
  description: "Internal project-history investigator — sourced answers for client escalations.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${inter.variable} ${newsreader.variable} ${jetbrains.variable}`}>
      <body>
        <header className="app-header">
          <div className="app-header-inner">
            <Link href="/" className="app-brand">
              Anduin Investigator
            </Link>
            <span className="muted small">internal report · not for external distribution</span>
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
