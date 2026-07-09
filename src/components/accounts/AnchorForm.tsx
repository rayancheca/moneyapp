"use client";

import { addAnchorAction } from "@/app/accounts/actions";

const FIELD =
  "rounded-md border border-line bg-surface-raised px-3 py-2 text-sm transition-colors duration-(--duration-fast) placeholder:text-ink-faint hover:border-line-strong focus:border-accent";

interface AnchorFormProps {
  accountId: string;
  isCredit: boolean;
  defaultDate: string;
}

export function AnchorForm({ accountId, isCredit, defaultDate }: AnchorFormProps) {
  return (
    <form action={addAnchorAction} className="flex flex-wrap items-end gap-3">
      <input type="hidden" name="accountId" value={accountId} />
      <label className="grid gap-1 text-xs font-medium text-ink-muted">
        Date
        <input type="date" name="anchoredOn" defaultValue={defaultDate} required className={FIELD} />
      </label>
      <label className="grid gap-1 text-xs font-medium text-ink-muted">
        {isCredit ? "Balance owed" : "Balance"}
        <input name="balance" required placeholder="1,234.56" className={`${FIELD} figures w-36`} />
      </label>
      <button
        type="submit"
        className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-surface-raised transition-opacity duration-(--duration-fast) hover:opacity-90 active:opacity-80"
      >
        Record balance
      </button>
    </form>
  );
}
