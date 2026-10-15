import type { Metadata } from "next";
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
      <body>{children}</body>
    </html>
  );
}
