"use client";

import { addHoldingAction } from "@/app/investments/actions";

interface InvestmentAccount {
  id: string;
  name: string;
  subtype: string | null;
}

const FIELD =
  "w-full rounded-md border border-line bg-surface-raised px-3 py-2 text-sm transition-colors duration-(--duration-fast) placeholder:text-ink-faint hover:border-line-strong focus:border-accent";

/**
 * Symbol is uppercased at entry; quantity is a plain decimal parsed to
 * exact 1e-8 units server-side (string math — no float rounding).
 */
export function HoldingForm({
  accounts,
  defaultDate,
}: {
  accounts: InvestmentAccount[];
  defaultDate: string;
}) {
  return (
    <form action={addHoldingAction} className="grid gap-3 md:grid-cols-2">
      <label className="grid gap-1 text-xs font-medium text-ink-muted">
        Account
        <select name="accountId" required className={FIELD}>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
              {a.subtype ? ` (${a.subtype})` : ""}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1 text-xs font-medium text-ink-muted">
        Symbol
        <input
          name="symbol"
          required
          placeholder="VOO"
          maxLength={12}
          className={`${FIELD} uppercase`}
          onChange={(e) => {
            e.target.value = e.target.value.toUpperCase();
          }}
        />
      </label>
      <label className="grid gap-1 text-xs font-medium text-ink-muted">
        Asset type
        <select name="assetType" required className={FIELD}>
          <option value="stock">Stock</option>
          <option value="etf">ETF</option>
          <option value="crypto">Crypto</option>
        </select>
      </label>
      <label className="grid gap-1 text-xs font-medium text-ink-muted">
        Quantity
        <input
          name="quantity"
          required
          inputMode="decimal"
          placeholder="0.5"
          pattern="[\d,]*\.?\d{0,8}"
          title="Up to 8 decimal places"
          className={`${FIELD} figures`}
        />
      </label>
      <label className="grid gap-1 text-xs font-medium text-ink-muted">
        Average cost per unit (optional)
        <input
          name="avgCost"
          inputMode="decimal"
          placeholder="412.50 — feeds P/L only, never net worth"
          className={`${FIELD} figures`}
        />
      </label>
      <label className="grid gap-1 text-xs font-medium text-ink-muted">
        As of
        <input type="date" name="occurredOn" defaultValue={defaultDate} className={FIELD} />
      </label>
      <div className="md:col-span-2">
        <button
          type="submit"
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-surface-raised transition-opacity duration-(--duration-fast) hover:opacity-90 active:opacity-80"
        >
          Save holding
        </button>
        <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
          Re-entering an existing symbol updates its quantity — the change is recorded as a dated
          buy/sell event, which drives the crypto account&apos;s value history.
        </p>
      </div>
    </form>
  );
}
