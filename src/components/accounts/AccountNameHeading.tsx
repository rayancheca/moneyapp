"use client";

import { useRouter } from "next/navigation";
import { renameAccountAction } from "@/app/accounts/actions";
import { InlineEditableText } from "@/components/ui/InlineEditableText";

/**
 * The account detail page's title, rendered as an inline-editable heading — the
 * first use of <InlineEditableText> (the "nothing read-only" primitive). The
 * name is editable right where it's shown, not only in the edit sheet. Type /
 * subtype / last4 stay in the sheet (changing them re-derives the balance curve).
 */
export function AccountNameHeading({
  accountId,
  name,
  description,
}: {
  accountId: string;
  name: string;
  description: string;
}) {
  const router = useRouter();
  return (
    <header className="mb-8 min-w-0">
      <h1 className="text-2xl font-semibold tracking-tight">
        <InlineEditableText
          value={name}
          label="Account name"
          maxLength={80}
          className="text-2xl font-semibold tracking-tight"
          onSave={async (next) => {
            const result = await renameAccountAction({ accountId, name: next });
            if (result.ok) router.refresh();
            return { ok: result.ok, error: result.ok ? undefined : result.error };
          }}
        />
      </h1>
      {description ? (
        <p className="mt-1.5 max-w-prose text-sm text-ink-muted">{description}</p>
      ) : null}
    </header>
  );
}
