import type { Metadata } from "next";
import { connection } from "next/server";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { ThemeProvider } from "next-themes";
import { getDb } from "@/db/client";
import { needsReviewCount } from "@/services/review-count";
import { AppShell } from "@/components/shell/AppShell";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "MoneyApp", template: "%s — MoneyApp" },
  description: "Local-first personal finance and net worth",
};

/** once per boot: a permanently-zero badge must leave a trace in server logs */
let reviewCountErrorReported = false;

/** Defensive: the badge must never take the shell down (e.g. before first boot/migration). */
function safeReviewCount(): number {
  try {
    return needsReviewCount(getDb());
  } catch (error: unknown) {
    if (!reviewCountErrorReported) {
      reviewCountErrorReported = true;
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[layout] needs-review badge fell back to 0: ${message}\n`);
    }
    return 0;
  }
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // request-time only: without this, `next build` prerenders /_not-found,
  // opening (or even CREATING) the database as a build side effect and
  // freezing a stale badge count into the built shell
  await connection();
  const reviewCount = safeReviewCount();
  return (
    <html
      lang="en"
      className={`${GeistSans.variable} ${GeistMono.variable}`}
      suppressHydrationWarning
    >
      <body>
        <ThemeProvider attribute="class" defaultTheme="light" disableTransitionOnChange>
          <AppShell reviewCount={reviewCount}>{children}</AppShell>
        </ThemeProvider>
      </body>
    </html>
  );
}
