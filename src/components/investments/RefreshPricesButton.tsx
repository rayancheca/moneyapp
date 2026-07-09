"use client";

import { useFormStatus } from "react-dom";
import { refreshPricesAction } from "@/app/investments/actions";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      aria-busy={pending}
      className="rounded-md border border-line bg-surface-raised px-3 py-1.5 text-xs font-medium transition-colors duration-(--duration-fast) hover:border-line-strong hover:text-accent active:bg-surface-sunken disabled:cursor-progress disabled:opacity-60"
    >
      {pending ? "Refreshing…" : "Refresh prices"}
    </button>
  );
}

/** Backfills missing daily closes, quotes today, and re-anchors net worth. */
export function RefreshPricesButton() {
  return (
    <form action={refreshPricesAction}>
      <SubmitButton />
    </form>
  );
}
