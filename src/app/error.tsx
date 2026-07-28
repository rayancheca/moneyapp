"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Icon } from "@/components/shell/Icon";
import { Button } from "@/components/ui/Button";
import { SurfaceCard } from "@/components/ui/SurfaceCard";

/** The shape Next hands to every `error.tsx` default export. */
export interface RouteError extends Error {
  digest?: string;
}

export interface RouteErrorProps {
  error: RouteError;
  reset: () => void;
}

interface ErrorSurfaceProps extends RouteErrorProps {
  /** Plain statement of what failed — no apology, no "oops". */
  headline: string;
  /** One sentence on what retrying does and what to look at. */
  detail: string;
  /** Escape hatch to a surface known to render. */
  back: { href: string; label: string };
}

/* Every route boundary renders the same panel with its own copy. This lives in
   the root `error.tsx` rather than `components/ui/` only because a boundary is
   the one thing that must never depend on a module that could itself be the
   thing that broke — and Next ignores named exports from a special file. */
export function ErrorSurface({ error, reset, headline, detail, back }: ErrorSurfaceProps) {
  // Next logs the digest server-side; the full error only ever reaches the
  // browser console if we put it there.
  useEffect(() => {
    console.error("[boundary]", error);
  }, [error]);

  return (
    <SurfaceCard className="flex flex-col items-start gap-5">
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full bg-negative-soft text-negative"
        >
          <Icon name="warning" className="size-4" />
        </span>
        <div className="min-w-0">
          <h1 className="text-lg font-semibold tracking-tight">{headline}</h1>
          <p className="mt-1.5 max-w-prose text-sm leading-relaxed text-ink-muted">{detail}</p>
        </div>
      </div>

      <ErrorDetail error={error} />

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={reset} icon="repeat">
          Try again
        </Button>
        <Link
          href={back.href}
          className="inline-flex items-center justify-center gap-1.5 rounded-md border border-line bg-surface-raised px-3 py-1.5 text-sm font-medium transition-colors duration-(--duration-fast) hover:border-line-strong"
        >
          <Icon name="chevron-left" className="size-3.5" />
          {back.label}
        </Link>
      </div>
    </SurfaceCard>
  );
}

/* This is the owner's own machine and his own money — the error is shown in
   full rather than swallowed behind a digest, because he is the one debugging
   it. `break-words` + the scroll container keep a long stack from widening the
   page at 440px. */
function ErrorDetail({ error }: { error: RouteError }) {
  const message = error.message.trim();
  return (
    <div className="w-full overflow-hidden rounded-md border border-line bg-surface-sunken">
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
          <summary className="cursor-pointer px-3 py-2 text-xs text-ink-muted transition-colors duration-(--duration-fast) hover:text-ink">
            Stack trace
          </summary>
          <pre className="overflow-x-auto px-3 pb-3 font-mono text-[11px] leading-relaxed text-ink-faint">
            {error.stack}
          </pre>
        </details>
      ) : null}
    </div>
  );
}

export default function RootError({ error, reset }: RouteErrorProps) {
  return (
    <ErrorSurface
      error={error}
      reset={reset}
      headline="This page didn't render."
      detail="Retrying re-runs this page from scratch. If you had just submitted a form, it did not go through — the message below is exactly what the app rejected."
      back={{ href: "/", label: "Dashboard" }}
    />
  );
}
