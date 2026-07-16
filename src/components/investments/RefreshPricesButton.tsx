"use client";

import { useState, useTransition } from "react";
import { refreshPricesAction } from "@/app/investments/actions";
import { toast } from "@/components/ui/Toast";

/** Press-time clock format for the "as of" stamp ("2:34 PM"). Client-only, so
 *  it never runs during SSR (asOf is null until a press) — no hydration drift. */
function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/**
 * Manual live-price refresh: forces a quote at the exact press time (bypassing
 * the staleness window), then stamps "Updated <time>" and toasts the outcome.
 * Provider outages degrade to cached prices (a neutral/negative toast), never an
 * error page. Under MONEYAPP_FAKE_PRICES the same path serves deterministic
 * prices for dev/e2e; the live path hits the real provider.
 */
export function RefreshPricesButton() {
  const [pending, startTransition] = useTransition();
  const [asOf, setAsOf] = useState<string | null>(null);

  function refresh() {
    startTransition(async () => {
      const res = await refreshPricesAction();
      if (!res.ok) {
        toast({ title: "Couldn't refresh prices", description: res.error, tone: "negative" });
        return;
      }
      const { quotedSymbols, errors, asOf: at } = res.data;
      if (quotedSymbols > 0) {
        setAsOf(at);
        // `errors` holds one string per failed symbol-backfill AND per failed
        // provider-quote batch, so a single outage yields several — never render
        // it as a source COUNT. quotedSymbols (symbols actually repriced) is exact.
        const repriced = `${quotedSymbols} ${quotedSymbols === 1 ? "holding" : "holdings"} repriced`;
        toast({
          title: "Prices updated",
          description:
            errors.length > 0
              ? `${repriced} · some sources were unreachable`
              : `as of ${formatTime(at)}`,
          tone: errors.length > 0 ? "neutral" : "positive",
        });
      } else if (errors.length > 0) {
        toast({
          title: "Couldn't reach the price provider",
          description: "Showing the last cached prices.",
          tone: "negative",
        });
      } else {
        toast({ title: "Prices are up to date", tone: "neutral" });
      }
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={refresh}
        disabled={pending}
        aria-busy={pending}
        className="rounded-md border border-line bg-surface-raised px-3 py-1.5 text-xs font-medium transition-colors duration-(--duration-fast) hover:border-line-strong hover:text-accent active:bg-surface-sunken disabled:cursor-progress disabled:opacity-60"
      >
        {pending ? "Refreshing…" : "Refresh prices"}
      </button>
      {asOf && !pending && (
        <span className="figures text-[11px] text-ink-faint">Updated {formatTime(asOf)}</span>
      )}
    </div>
  );
}
