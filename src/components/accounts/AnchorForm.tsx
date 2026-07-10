"use client";

import { addAnchorAction } from "@/app/accounts/actions";
import { Field, Input } from "@/components/ui/Field";

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
        <Input type="date" name="anchoredOn" defaultValue={defaultDate} required />
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
