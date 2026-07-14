"use client";

import { useRouter } from "next/navigation";
import { renameMerchantAction } from "@/app/transactions/actions";
import { InlineEditableText } from "@/components/ui/InlineEditableText";

/**
 * The merchant detail title as an inline-editable heading (S3) — the rename
 * that used to live only in the transaction sheet. renameMerchant records the
 * old name as a contains-alias so future imports still resolve here.
 */
export function MerchantNameHeading({
  merchantId,
  name,
  description,
}: {
  merchantId: string;
  name: string;
  description: string;
}) {
  const router = useRouter();
  return (
    <header className="mb-8 min-w-0">
      <h1 className="text-2xl font-semibold tracking-tight">
        <InlineEditableText
          value={name}
          label="Merchant name"
          maxLength={80}
          className="text-2xl font-semibold tracking-tight"
          onSave={async (next) => {
            const result = await renameMerchantAction({ merchantId, newName: next });
            if (result.ok) router.refresh();
            return { ok: result.ok, error: result.ok ? undefined : result.error };
          }}
        />
      </h1>
      <p className="mt-1.5 max-w-prose text-sm text-ink-muted">{description}</p>
    </header>
  );
}
