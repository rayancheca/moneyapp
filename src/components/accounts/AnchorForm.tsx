"use client";

import { addAnchorAction } from "@/app/accounts/actions";
import { Field, Input } from "@/components/ui/Field";
import { MAX_FINANCIAL_DATE, MIN_FINANCIAL_DATE } from "@/lib/date-window";

interface AnchorFormProps {
  accountId: string;
  isCredit: boolean;
  defaultDate: string;
}

export function AnchorForm({ accountId, isCredit, defaultDate }: AnchorFormProps) {
  return (
    <form action={addAnchorAction} className="flex flex-wrap items-end gap-3">
      <input type="hidden" name="accountId" value={accountId} />
      <Field label="Date">
        {/* the bounds mirror manualAnchorInputSchema exactly, so a fat-fingered
            year is refused by the browser before it can reach derivation */}
        <Input
          type="date"
          name="anchoredOn"
          defaultValue={defaultDate}
          min={MIN_FINANCIAL_DATE}
          max={MAX_FINANCIAL_DATE}
          required
        />
      </Field>
      {/* fixed width lives on the Field wrapper (not the w-full Input) so the
          two width utilities never compete — same rendered 9rem as before */}
      <Field label={isCredit ? "Balance owed" : "Balance"} className="w-36">
        <Input name="balance" required placeholder="1,234.56" className="figures" />
      </Field>
      <button
        type="submit"
        className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-surface-raised transition-opacity duration-(--duration-fast) hover:opacity-90 active:opacity-80"
      >
        Record balance
      </button>
    </form>
  );
}
