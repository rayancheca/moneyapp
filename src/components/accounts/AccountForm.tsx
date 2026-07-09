"use client";

import { useState } from "react";
import { createAccountAction } from "@/app/accounts/actions";

interface Institution {
  id: string;
  name: string;
}

const FIELD =
  "w-full rounded-md border border-line bg-surface-raised px-3 py-2 text-sm transition-colors duration-(--duration-fast) placeholder:text-ink-faint hover:border-line-strong focus:border-accent";

export function AccountForm({ institutions }: { institutions: Institution[] }) {
  const [type, setType] = useState("checking");
  const isCredit = type === "credit";
  return (
    <form action={createAccountAction} className="grid gap-3 md:grid-cols-2">
      <label className="grid gap-1 text-xs font-medium text-ink-muted">
        Institution
        <select name="institutionId" required className={FIELD}>
          {institutions.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1 text-xs font-medium text-ink-muted">
        Account name
        <input name="name" required placeholder="Chase Checking" className={FIELD} />
      </label>
      <label className="grid gap-1 text-xs font-medium text-ink-muted">
        Type
        <select name="type" value={type} onChange={(e) => setType(e.target.value)} className={FIELD}>
          <option value="checking">Checking</option>
          <option value="savings">Savings</option>
          <option value="credit">Credit card</option>
          <option value="investment">Investment</option>
        </select>
      </label>
      {type === "investment" ? (
        <label className="grid gap-1 text-xs font-medium text-ink-muted">
          Investment kind
          <select name="subtype" className={FIELD}>
            <option value="brokerage">Brokerage</option>
            <option value="crypto">Crypto</option>
          </select>
        </label>
      ) : (
        <label className="grid gap-1 text-xs font-medium text-ink-muted">
          Card / account last 4 (optional)
          <input name="last4" placeholder="1234" pattern="\d{4}" className={FIELD} />
        </label>
      )}
      <label className="grid gap-1 text-xs font-medium text-ink-muted md:col-span-2">
        {isCredit ? "Current balance owed (optional)" : "Current balance (optional)"}
        <input
          name="initialBalance"
          placeholder={isCredit ? "1,240.50 — what you owe today" : "5,230.00"}
          className={`${FIELD} figures`}
        />
      </label>
      <div className="md:col-span-2">
        <button
          type="submit"
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-surface-raised transition-opacity duration-(--duration-fast) hover:opacity-90 active:opacity-80"
        >
          Add account
        </button>
      </div>
    </form>
  );
}
