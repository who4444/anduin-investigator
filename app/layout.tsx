import type { Metadata } from "next";
import Link from "next/link";
import { Atkinson_Hyperlegible, JetBrains_Mono, Source_Serif_4 } from "next/font/google";

import "./globals.css";

const atkinson = Atkinson_Hyperlegible({
  subsets: ["latin"],
  weight: ["400", "700"],
  variable: "--font-atkinson",
});

const sourceSerif = Source_Serif_4({
  subsets: ["latin"],
  weight: ["400", "600"],
  variable: "--font-source-serif",
});

const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "700"],
  variable: "--font-jetbrains",
});

export const metadata: Metadata = {
  title: "Anduin Investigator",
  description: "Internal project-history investigator — sourced answers for client escalations.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${atkinson.variable} ${sourceSerif.variable} ${jetbrains.variable}`}>
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
