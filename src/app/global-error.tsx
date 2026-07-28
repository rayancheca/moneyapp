"use client";

import { useEffect, useState } from "react";
import "./globals.css";

/**
 * Last line of defence: this replaces the root layout itself, so it owns the
 * <html>/<body> and cannot use AppShell, ThemeProvider or anything that needs
 * server data — reaching this file means the layout is the thing that broke.
 * Deliberately dependency-free apart from the stylesheet.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    console.error("[global-boundary]", error);
  }, [error]);

  useEffect(() => {
    // next-themes never mounts here, so read the key it persists directly.
    // Mirrors the provider's config: attribute="class", defaultTheme="light".
    try {
      const stored = window.localStorage.getItem("theme");
      const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      setIsDark(stored === "dark" || (stored === "system" && prefersDark));
    } catch {
      // localStorage can throw under restrictive privacy settings — light is the default
    }
  }, []);

  const message = error.message.trim();

  return (
    <html lang="en" className={isDark ? "dark" : undefined} suppressHydrationWarning>
      <body className="bg-surface text-ink">
        <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col justify-center gap-6 px-4 py-12 md:px-8">
          <div className="flex items-center gap-2">
            <span className="inline-block size-2.5 rounded-full bg-negative" aria-hidden />
            <span className="text-sm font-semibold tracking-tight">MoneyApp</span>
          </div>

          <div>
            <h1 className="text-2xl font-semibold tracking-tight">The app shell crashed.</h1>
            <p className="mt-2 max-w-prose text-sm leading-relaxed text-ink-muted">
              This is the boundary below everything else — the failure happened in the layout
              itself, not on one page, so the sidebar and header are gone with it. Your database on
              disk is untouched; nothing here reads or writes it.
            </p>
          </div>

          <div className="overflow-hidden rounded-(--radius-card) border border-line bg-surface-sunken">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-line px-3 py-2">
              <span className="text-[11px] font-medium tracking-wide text-ink-faint uppercase">
                What was thrown
              </span>
              {error.digest ? (
                <span className="font-mono text-[11px] text-ink-faint">digest {error.digest}</span>
              ) : null}
            </div>
            <p className="px-3 py-2.5 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">
              {message || "The error carried no message — the digest above is the only handle on it."}
            </p>
            {error.stack ? (
              <details className="border-t border-line">
                <summary className="cursor-pointer px-3 py-2 text-xs text-ink-muted">
                  Stack trace
                </summary>
                <pre className="overflow-x-auto px-3 pb-3 font-mono text-[11px] leading-relaxed text-ink-faint">
                  {error.stack}
                </pre>
              </details>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={reset}
              className="inline-flex items-center justify-center rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-surface-raised transition-opacity duration-(--duration-fast) hover:opacity-90 active:opacity-80"
            >
              Try again
            </button>
            {/* a full document load, not a client navigation — the router is part
                of what just failed */}
            <a
              href="/"
              className="inline-flex items-center justify-center rounded-md border border-line bg-surface-raised px-3 py-1.5 text-sm font-medium transition-colors duration-(--duration-fast) hover:border-line-strong"
            >
              Reload the dashboard
            </a>
          </div>

          <p className="text-xs text-ink-faint">
            Local-first · the same message is in the terminal running the dev server
          </p>
        </main>
      </body>
    </html>
  );
}
