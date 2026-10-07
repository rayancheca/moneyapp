"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Field, Input, Select } from "@/components/ui/Field";
import { Money } from "@/components/ui/Money";
import { Sheet } from "@/components/ui/Sheet";
import { toast } from "@/components/ui/Toast";
import { InlineEditableAmount } from "@/components/ui/InlineEditableAmount";
import { addManualTransactionAction } from "@/app/transactions/actions";
import { createCashWalletAction, setCashWalletOpeningAction } from "@/app/accounts/cash-actions";
import { CategoryPicker, type CategoryPickerOption } from "@/components/transactions/CategoryPicker";
import { MAX_FINANCIAL_DATE, MIN_FINANCIAL_DATE, MIN_OPENING_DATE } from "@/lib/date-window";
import { formatCents } from "@/lib/money";

/**
 * Cash wallets (ux-overhaul-plan §3.7): create an import-free wallet for the
 * cash economy and add manual transactions to it. Manual rows are only allowed
 * here (a manual row on a statement-anchored account would break its
 * to-the-cent reconciliation), and they DO drive the wallet's balance.
 */

export interface CashWalletView {
  id: string;
  name: string;
  balanceCents: number | null;
  openingCents: number | null;
  anchorCount: number;
}

interface CashWalletsProps {
  wallets: readonly CashWalletView[];
  categories: readonly CategoryPickerOption[];
  today: string;
}

const NEW_WALLET_TRIGGER_ID = "new-cash-wallet-trigger";

export function CashWallets({ wallets, categories, today }: CashWalletsProps) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [creating, setCreating] = useState(false);
  const [addFor, setAddFor] = useState<CashWalletView | null>(null);
  // when the create form closes, return focus to its trigger (the form is a
  // plain region, not a dialog, so there is no native focus restoration)
  const restoreTriggerFocus = useRef(false);

  useEffect(() => {
    if (!creating && restoreTriggerFocus.current) {
      restoreTriggerFocus.current = false;
      document.getElementById(NEW_WALLET_TRIGGER_ID)?.focus();
    }
  }, [creating]);

  function refresh(): void {
    startTransition(() => router.refresh());
  }

  function closeForm(): void {
    restoreTriggerFocus.current = true;
    setCreating(false);
  }

  return (
    <div className="space-y-4">
      {wallets.length > 0 ? (
        <ul className="divide-y divide-line">
          {wallets.map((w) => (
            <li key={w.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 py-2">
              <div className="min-w-0">
                <span className="block truncate text-sm font-medium">{w.name}</span>
                <OpeningBalance wallet={w} onSaved={refresh} />
              </div>
              <div className="flex items-center gap-3">
                {w.balanceCents !== null ? (
                  <Money cents={w.balanceCents} className="figures text-sm text-ink-muted" />
                ) : (
                  <span className="text-xs text-ink-faint">no balance yet</span>
                )}
                <Button
                  variant="secondary"
                  size="sm"
                  icon="plus"
                  aria-label={`Add transaction to ${w.name}`}
                  onClick={() => setAddFor(w)}
                >
                  Add transaction
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-ink-muted">
          No cash wallets yet. Add one to track cash the statements don&apos;t see — like the weekly
          ATM withdrawal you spend down over the week.
        </p>
      )}

      {creating ? (
        <NewWalletForm
          today={today}
          onDone={() => {
            closeForm();
            refresh();
          }}
          onCancel={closeForm}
        />
      ) : (
        <Button id={NEW_WALLET_TRIGGER_ID} variant="ghost" size="sm" icon="plus" onClick={() => setCreating(true)}>
          New cash wallet
        </Button>
      )}

      {addFor ? (
        <AddTransactionSheet
          wallet={addFor}
          categories={categories}
          today={today}
          onClose={() => setAddFor(null)}
          onSaved={() => {
            setAddFor(null);
            refresh();
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * The wallet's opening cash, editable in place.
 *
 * This is the affordance the create form alone could not provide: a wallet made
 * before "Cash on hand" existed — or made with the box left empty — opened at
 * $0 and there was no way to say otherwise, so it read $0.00 forever.
 *
 * The DATE is deliberately not editable here. Re-anchoring the wallet's own
 * opening day is an upsert; a different day would insert a second anchor, and
 * two unequal anchors with no transactions between them turn the whole span to
 * basis='gap' and drop it from the chart. The account page's "Add a balance you
 * counted" form is the place to add a LATER count.
 */
function OpeningBalance({ wallet, onSaved }: { wallet: CashWalletView; onSaved: () => void }) {
  if (wallet.openingCents === null) return null;

  // Above one recorded balance, editing the opening moves nothing the owner can
  // see — derivation seeds its forward walk from the LAST anchor. Saying so
  // beats a success toast over an unchanged number.
  if (wallet.anchorCount > 1) {
    // Editing the opening here would move nothing the owner can see — derivation
    // seeds its forward walk from the LAST anchor — and can flip the span
    // between the two anchors to basis='gap', which drops those days from the
    // chart and from net-worth coverage. Withholding the editor without saying
    // where to go would strand a wallet whose opening is wrong, so link to the
    // page that can actually reconcile the two figures.
    return (
      <span className="text-xs text-ink-faint">
        Opened with <Money cents={wallet.openingCents} className="figures" /> ·{" "}
        <Link href={`/accounts/${wallet.id}`} className="underline hover:text-ink">
          later balances counted
        </Link>
      </span>
    );
  }

  return (
    <span className="flex flex-wrap items-baseline gap-x-1 text-xs text-ink-faint">
      <span>Opened with</span>
      <InlineEditableAmount
        valueCents={wallet.openingCents}
        label={`Opening cash for ${wallet.name}`}
        className="text-xs"
        describe={(cents) => `Opening cash set to ${formatCents(cents)}`}
        onSave={async (nextCents) => {
          if (nextCents < 0) return { ok: false, error: "Cash on hand cannot be negative" };
          const r = await setCashWalletOpeningAction({
            accountId: wallet.id,
            openingBalanceCents: nextCents,
          });
          if (r.ok) onSaved();
          return r.ok ? { ok: true } : { ok: false, error: r.error };
        }}
      />
    </span>
  );
}

function NewWalletForm({
  today,
  onDone,
  onCancel,
}: {
  today: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [openingOn, setOpeningOn] = useState(today);
  const [openingBalance, setOpeningBalance] = useState("");
  const [busy, setBusy] = useState(false);
  // an empty box means "start empty"; validate on CENTS so a sub-cent entry
  // cannot round into a silently different opening figure
  const openingCents = openingBalance.trim() === "" ? 0 : Math.round(Number(openingBalance) * 100);
  const openingValid = Number.isFinite(openingCents) && openingCents >= 0;
  const canSubmit = name.trim() !== "" && openingValid && !busy;

  function submit(): void {
    if (!canSubmit) return;
    setBusy(true);
    void createCashWalletAction({ name: name.trim(), openingOn, openingBalanceCents: openingCents }).then((r) => {
      setBusy(false);
      if (!r.ok) {
        toast({ title: r.error, tone: "negative" });
        return;
      }
      toast({ title: `Created "${name.trim()}"` });
      onDone();
    });
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="grid gap-3 rounded-(--radius-card) border border-line p-3"
    >
      {/* three fields at most on one row, and the buttons on their own — a
          fourth control here pushed Create and Cancel outside the viewport
          between 768 and 1024px, where the overflow gate (320/375/440) cannot
          see because the form has already stacked at those widths */}
      {/* lg, not sm: measured, the three controls need 833px of content width,
          so at 768-900 a sm: breakpoint scrolls the whole document sideways */}
      <div className="grid gap-3 lg:grid-cols-[1fr_auto_auto] lg:items-end">
      <Field label="Wallet name">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Cash" fieldSize="sm" autoFocus />
      </Field>
      <Field label="Cash on hand">
        {/* the wallet's opening anchor — without it a new wallet could only
            open empty, so creating one never moved a single balance */}
        <Input
          type="number"
          min="0"
          step="0.01"
          inputMode="decimal"
          value={openingBalance}
          onChange={(e) => setOpeningBalance(e.target.value)}
          placeholder="0.00"
          fieldSize="sm"
          className="figures"
        />
      </Field>
      <Field label="Opening date">
        {/* the opening date becomes the wallet's first anchor — bound the year
            here so the browser refuses a typo before derivation walks it.
            MIN_OPENING_DATE, not MIN_FINANCIAL_DATE: the anchor lands the day
            BEFORE this, so the floor itself used to throw after the account row
            had already been written. The schema refuses it too — this only
            stops the browser from offering it. */}
        <Input
          type="date"
          value={openingOn}
          onChange={(e) => setOpeningOn(e.target.value)}
          min={MIN_OPENING_DATE}
          /* today, not MAX_FINANCIAL_DATE: a future opening date parks the whole
             opening balance in the future and drags the net-worth series past
             today — measured, a 2027 date moved the last point to 2026-12-31 */
          max={today}
          fieldSize="sm"
          className="figures"
        />
      </Field>
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" pending={busy} disabled={!canSubmit}>
          Create
        </Button>
      </div>
    </form>
  );
}

const TXN_FORM_ID = "cash-txn-form";

function AddTransactionSheet({
  wallet,
  categories,
  today,
  onClose,
  onSaved,
}: {
  wallet: CashWalletView;
  categories: readonly CategoryPickerOption[];
  today: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [amount, setAmount] = useState("");
  const [direction, setDirection] = useState<"spent" | "received">("spent");
  const [postedOn, setPostedOn] = useState(today);
  const [description, setDescription] = useState("");
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  // validate on CENTS, not the dollar string: sub-cent amounts round to 0 and
  // the service rejects "Amount cannot be zero" — catch that on the client
  const cents = Math.round(Number(amount) * 100);
  const canSubmit = Number.isFinite(cents) && cents >= 1 && description.trim() !== "" && !busy;

  function submit(): void {
    if (!canSubmit) return;
    setBusy(true);
    void addManualTransactionAction({
      accountId: wallet.id,
      postedOn,
      amountCents: direction === "spent" ? -cents : cents,
      description: description.trim(),
      ...(categoryId ? { categoryId } : {}),
      ...(notes.trim() !== "" ? { notes: notes.trim() } : {}),
    }).then((r) => {
      setBusy(false);
      if (!r.ok) {
        toast({ title: r.error, tone: "negative" });
        return;
      }
      toast({ title: `Added to ${wallet.name}` });
      onSaved();
    });
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title={`Add to ${wallet.name}`}
      footer={
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={TXN_FORM_ID} size="sm" pending={busy} disabled={!canSubmit}>
            Add transaction
          </Button>
        </div>
      }
    >
      <form
        id={TXN_FORM_ID}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="space-y-4"
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="Amount">
            <Input
              type="number"
              min="0"
              step="0.01"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              className="figures"
              autoFocus
            />
          </Field>
          <Field label="Direction">
            <Select value={direction} onChange={(e) => setDirection(e.target.value as "spent" | "received")}>
              <option value="spent">Spent</option>
              <option value="received">Received</option>
            </Select>
          </Field>
        </div>

        <Field label="Date">
          {/* bounds mirror manualTxnInputSchema — a manual row drives the
              wallet's replay, so an absurd year is refused at the input */}
          <Input
            type="date"
            value={postedOn}
            onChange={(e) => setPostedOn(e.target.value)}
            min={MIN_FINANCIAL_DATE}
            max={MAX_FINANCIAL_DATE}
            className="figures"
          />
        </Field>

        <Field label="Description">
          <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. Coffee, groceries" />
        </Field>

        <div className="space-y-1.5">
          <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-ink-faint">Category</span>
          <div>
            <CategoryPicker options={categories} currentId={categoryId} onPick={setCategoryId} />
          </div>
        </div>

        <Field label="Note">
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
        </Field>
      </form>
    </Sheet>
  );
}
