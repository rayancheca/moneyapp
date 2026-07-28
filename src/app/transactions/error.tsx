"use client";

import { ErrorSurface, type RouteErrorProps } from "@/app/error";

export default function TransactionsError({ error, reset }: RouteErrorProps) {
  return (
    <ErrorSurface
      error={error}
      reset={reset}
      headline="The ledger didn't load."
      detail="Filters, the view tab and the page number all come from the URL, so a bad value there is the usual cause — the link below reopens the ledger with every filter cleared. Retry re-reads the same query."
      back={{ href: "/transactions", label: "Ledger, filters cleared" }}
    />
  );
}
