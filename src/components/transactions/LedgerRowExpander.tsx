"use client";

import { useEffect, useState } from "react";
import { InlineEditableAmount } from "@/components/ui/InlineEditableAmount";
import { InlineEditableText } from "@/components/ui/InlineEditableText";
import { Money } from "@/components/ui/Money";
import { resolveDateCommit } from "@/lib/inline-edit";
import {
  editManualTransactionAction,
  renameMerchantAction,
  setFlagsAction,
} from "@/app/transactions/actions";
import { loadSheetPanel } from "@/app/transactions/sheet-actions";
import type { LedgerRow } from "./TransactionsLedger";

/**
 * The inline row expander (S4 of "nothing read-only"): the transaction's
 * fields edit right in the ledger, without opening the sheet. Notes edit on
 * every row; date / amount / description edit ONLY on manual rows — imported
 * rows are the audit trail and stay immutable (their facts render read-only,
 * labeled as imported). The merchant name renames through the same service the
 * sheet uses (old name becomes a matching alias).
 */
export function LedgerRowExpander({ row, onChanged }: { row: LedgerRow; onChanged: () => void }) {
  const [merchant, setMerchant] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => {
    if (!row.merchantId) return;
    let cancelled = false;
    void loadSheetPanel(row.id).then((r) => {
      if (!cancelled && r.ok && r.data.merchant) {
        setMerchant({ id: r.data.merchant.id, name: r.data.merchant.name });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [row.id, row.merchantId]);

  const fieldLabel = "text-[11px] font-medium uppercase tracking-[0.12em] text-ink-faint";

  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-3 border-t border-line/60 bg-surface-sunken/40 px-4 py-3 sm:grid-cols-4">
      <div className="min-w-0 space-y-0.5">
        <div className={fieldLabel}>Date</div>
        {row.isManual ? (
          <InlineEditableText
            value={row.postedOn}
            label="Transaction date"
            resolve={resolveDateCommit}
            className="figures text-sm"
            describe={(next) => `Date set to ${next}`}
            onSave={async (next) => {
              const result = await editManualTransactionAction({
                transactionId: row.id,
                patch: { postedOn: next },
              });
              if (result.ok) onChanged();
              return { ok: result.ok, error: result.ok ? undefined : result.error };
            }}
          />
        ) : (
          <div className="figures text-sm">{row.postedOn}</div>
        )}
      </div>

      <div className="min-w-0 space-y-0.5">
        <div className={fieldLabel}>Amount</div>
        {row.isManual ? (
          <InlineEditableAmount
            valueCents={row.amountCents}
            label="Amount"
            signed
            className="text-sm"
            onSave={async (nextCents) => {
              const result = await editManualTransactionAction({
                transactionId: row.id,
                patch: { amountCents: nextCents },
              });
              if (result.ok) onChanged();
              return { ok: result.ok, error: result.ok ? undefined : result.error };
            }}
          />
        ) : (
          <Money cents={row.amountCents} flow className="figures text-sm" />
        )}
      </div>

      <div className="min-w-0 space-y-0.5">
        <div className={fieldLabel}>{row.isManual ? "Description" : "Merchant"}</div>
        {row.isManual ? (
          <InlineEditableText
            value={row.rawDescription}
            label="Description"
            maxLength={200}
            className="text-sm"
            describe={(next) => `Description set to “${next}”`}
            onSave={async (next) => {
              const result = await editManualTransactionAction({
                transactionId: row.id,
                patch: { description: next },
              });
              if (result.ok) onChanged();
              return { ok: result.ok, error: result.ok ? undefined : result.error };
            }}
          />
        ) : merchant ? (
          <div className="text-sm">
            <InlineEditableText
              value={merchant.name}
              label="Merchant name"
              maxLength={80}
              className="text-sm"
              onSave={async (next) => {
                const result = await renameMerchantAction({ merchantId: merchant.id, newName: next });
                if (result.ok) {
                  setMerchant({ ...merchant, name: next });
                  onChanged();
                }
                return { ok: result.ok, error: result.ok ? undefined : result.error };
              }}
            />
          </div>
        ) : (
          <div className="truncate text-sm text-ink-muted" title={row.rawDescription}>
            {row.merchantId ? "…" : "—"}
          </div>
        )}
      </div>

      <div className="min-w-0 space-y-0.5">
        <div className={fieldLabel}>Notes</div>
        <div className="text-sm">
          <InlineEditableText
            value={row.notes ?? ""}
            label="Notes"
            required={false}
            maxLength={2000}
            placeholder="Add a note…"
            className="text-sm"
            describe={(next) => (next === "" ? "Note cleared" : "Note saved")}
            onSave={async (next) => {
              const result = await setFlagsAction({
                transactionId: row.id,
                flags: { notes: next === "" ? null : next },
              });
              if (result.ok) onChanged();
              return { ok: result.ok, error: result.ok ? undefined : result.error };
            }}
          />
        </div>
      </div>

      {!row.isManual ? (
        <div className="col-span-2 -mt-1 text-[11px] text-ink-faint sm:col-span-4">
          Imported row — date and amount are the audit trail and stay as the bank reported them.
          Raw: <span className="figures">{row.rawDescription}</span>
        </div>
      ) : null}
    </div>
  );
}
