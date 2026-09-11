"use client";

import { addHoldingAction } from "@/app/investments/actions";
import { accountSubtypeLabel } from "@/lib/account-label";
import { Field, Input, Select } from "@/components/ui/Field";
import { MAX_FINANCIAL_DATE, MIN_FINANCIAL_DATE } from "@/lib/date-window";

interface InvestmentAccount {
  id: string;
  name: string;
  subtype: string | null;
}

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
      <Field label="Account">
        <Select name="accountId" required>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
              {accountSubtypeLabel(a.subtype) ? ` (${accountSubtypeLabel(a.subtype)})` : ""}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Symbol">
        <Input
          name="symbol"
          required
          placeholder="VOO"
          maxLength={12}
          className="uppercase"
          onChange={(e) => {
            e.target.value = e.target.value.toUpperCase();
          }}
        />
      </Field>
      <Field label="Asset type">
        <Select name="assetType" required>
          <option value="stock">Stock</option>
          <option value="etf">ETF</option>
          <option value="crypto">Crypto</option>
        </Select>
      </Field>
      <Field label="Quantity">
        <Input
          name="quantity"
          required
          inputMode="decimal"
          placeholder="0.5"
          pattern="[\d,]*\.?\d{0,8}"
          title="Up to 8 decimal places"
          className="figures"
        />
      </Field>
      <Field label="Average cost per unit (optional)">
        <Input
          name="avgCost"
          inputMode="decimal"
          placeholder="412.50 — feeds P/L only, never net worth"
          className="figures"
        />
      </Field>
      <Field label="As of">
        {/* bounds mirror holdingInputSchema — this date seeds the holding's
            value timeline, which is walked one day at a time */}
        <Input
          type="date"
          name="occurredOn"
          defaultValue={defaultDate}
          min={MIN_FINANCIAL_DATE}
          max={MAX_FINANCIAL_DATE}
        />
      </Field>
      <div className="md:col-span-2">
        <button
          type="submit"
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-surface-raised transition-opacity duration-(--duration-fast) hover:opacity-90 active:opacity-80"
        >
          Save holding
        </button>
        {/* 🔴 "the crypto account's" — of a form whose Account select offers
            TWO, and whose default is the brokerage. `rebuildAccount`
            short-circuits ANY investment account holding positions into
            `rebuildInvestmentHistory`, which makes no crypto/brokerage
            distinction, and /accounts says the same back: "Robinhood Brokerage
            is priced from its holdings". Measured 2026-09-10 — Robinhood
            Brokerage carries 1,992 holding events across 33 symbols against
            Robinhood Crypto's 75 across one. */}
        <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
          Re-entering an existing symbol updates its quantity — the change is recorded as a dated
          buy/sell event, which drives the selected account&apos;s value history.
        </p>
      </div>
    </form>
  );
}
