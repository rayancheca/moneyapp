"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Field, Input, Select } from "@/components/ui/Field";
import { Money } from "@/components/ui/Money";
import { Sheet } from "@/components/ui/Sheet";
import { toast } from "@/components/ui/Toast";
import { addManualTransactionAction } from "@/app/transactions/actions";
import { createCashWalletAction } from "@/app/accounts/cash-actions";
import { CategoryPicker, type CategoryPickerOption } from "@/components/transactions/CategoryPicker";

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
            <li key={w.id} className="flex items-center justify-between gap-3 py-2">
              <span className="text-sm font-medium">{w.name}</span>
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
  const [busy, setBusy] = useState(false);
  const canSubmit = name.trim() !== "" && !busy;

  function submit(): void {
    if (!canSubmit) return;
    setBusy(true);
    void createCashWalletAction({ name: name.trim(), openingOn }).then((r) => {
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
      className="grid gap-3 rounded-(--radius-card) border border-line p-3 sm:grid-cols-[1fr_auto_auto_auto] sm:items-end"
    >
      <Field label="Wallet name">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Cash" fieldSize="sm" autoFocus />
      </Field>
      <Field label="Opening date">
        <Input type="date" value={openingOn} onChange={(e) => setOpeningOn(e.target.value)} fieldSize="sm" className="figures" />
      </Field>
      <Button type="submit" size="sm" pending={busy} disabled={!canSubmit}>
        Create
      </Button>
      <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
        Cancel
      </Button>
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
          <Input type="date" value={postedOn} onChange={(e) => setPostedOn(e.target.value)} className="figures" />
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
