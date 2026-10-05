import type { Metadata } from "next";
import { connection } from "next/server";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { ThemeProvider } from "next-themes";
import { getDb } from "@/db/client";
import { commandEntityGroups } from "@/services/command-index";
import { needsReviewCount } from "@/services/review-count";
import { openDuplicateCount } from "@/services/duplicate-count";
import { AppShell } from "@/components/shell/AppShell";
import { PageAsksProvider } from "@/hooks/usePageAsks";
import type { CommandPaletteGroup } from "@/components/ui/CommandPalette";
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

/** once per boot: see safeReviewCount — a permanently-zero badge must be traceable */
let duplicateCountErrorReported = false;

/**
 * Deliberately a SEPARATE try/catch from safeReviewCount, not a shared one.
 * `duplicate_candidates` arrives only in migration 0008, so on a database that
 * predates it this query throws — and sharing the catch would zero the REVIEW
 * badge too, which is exactly the silent-zero failure the comment above exists
 * to prevent.
 *
 * Any future mutation that can create a candidate must revalidate `/` and
 * `/transactions`, or this pill goes stale.
 */
function safeDuplicateCount(): number {
  try {
    return openDuplicateCount(getDb());
  } catch (error: unknown) {
    if (!duplicateCountErrorReported) {
      duplicateCountErrorReported = true;
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[layout] duplicates badge fell back to 0: ${message}\n`);
    }
    return 0;
  }
}

let paletteErrorReported = false;

/** Defensive: a bad entity query must never take the whole shell down. */
function safeEntityGroups(): CommandPaletteGroup[] {
  try {
    return commandEntityGroups(getDb());
  } catch (error: unknown) {
    if (!paletteErrorReported) {
      paletteErrorReported = true;
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[layout] ⌘K entity index fell back to empty: ${message}\n`);
    }
    return [];
  }
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // request-time only: without this, `next build` prerenders /_not-found,
  // opening (or even CREATING) the database as a build side effect and
  // freezing a stale badge count into the built shell
  await connection();
  const reviewCount = safeReviewCount();
  const duplicateCount = safeDuplicateCount();
  const entityGroups = safeEntityGroups();
  return (
    <html
      lang="en"
      className={`${GeistSans.variable} ${GeistMono.variable}`}
      suppressHydrationWarning
    >
      <body>
        <ThemeProvider attribute="class" defaultTheme="light" disableTransitionOnChange>
          <AppShell
            reviewCount={reviewCount}
            duplicateCount={duplicateCount}
            entityGroups={entityGroups}
          >
            {/* the page's asked view: what a press builds on while another is in flight */}
            <PageAsksProvider>{children}</PageAsksProvider>
          </AppShell>
        </ThemeProvider>
      </body>
    </html>
  );
}
