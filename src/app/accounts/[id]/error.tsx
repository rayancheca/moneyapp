"use client";

import { ErrorSurface, type RouteErrorProps } from "@/app/error";

export default function AccountDetailError({ error, reset }: RouteErrorProps) {
  return (
    <ErrorSurface
      error={error}
      reset={reset}
      headline="This account page didn't load."
      detail="Balances here are derived from transactions and anchors, so a rejected amount or date is the usual cause — the message below says which. Retry re-derives the account from what is actually stored."
      back={{ href: "/accounts", label: "All accounts" }}
    />
  );
}
