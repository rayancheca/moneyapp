"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { editAccountAction } from "@/app/accounts/actions";
import { Button } from "@/components/ui/Button";
import { Checkbox, Field, Input, Select } from "@/components/ui/Field";
import { Sheet } from "@/components/ui/Sheet";
import { toast } from "@/components/ui/Toast";
import { ACCOUNT_TYPES, ACCOUNT_SUBTYPES, type AccountType, type AccountSubtype } from "@/db/schema/accounts";

export interface EditableAccount {
  id: string;
  name: string;
  institutionId: string;
  last4: string | null;
  type: AccountType;
  subtype: AccountSubtype | null;
}

const TYPE_LABELS: Record<AccountType, string> = {
  checking: "Checking",
  savings: "Savings",
  credit: "Credit card",
  investment: "Investment",
};

const SUBTYPE_LABELS: Record<AccountSubtype, string> = {
  brokerage: "Brokerage",
  crypto: "Crypto",
};

/**
 * Edit-account sheet (ux-overhaul-plan §7.2, extended by S3): rename, re-home
 * to another institution, fix the last4 — and now type/subtype, gated behind
 * an explicit "re-derives history" confirmation because they flip the
 * account's liability/derivation semantics and rewrite its balance curve.
 */
export function EditAccountSheet({
  account,
  institutions,
  onClose,
}: {
  account: EditableAccount;
  institutions: readonly { id: string; name: string }[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState(account.name);
  const [institutionId, setInstitutionId] = useState(account.institutionId);
  const [last4, setLast4] = useState(account.last4 ?? "");
  const [type, setType] = useState<AccountType>(account.type);
  const [subtype, setSubtype] = useState<AccountSubtype | "">(account.subtype ?? "");
  const [confirmRederive, setConfirmRederive] = useState(false);

  const [saving, setSaving] = useState(false);

  const effectiveSubtype = type === "investment" ? (subtype === "" ? null : subtype) : null;
  const semanticsChanged = type !== account.type || effectiveSubtype !== account.subtype;

  function save(): void {
    if (saving) return; // one in-flight save — Enter/click can't double-submit
    if (semanticsChanged && !confirmRederive) {
      toast({ title: "Confirm the balance-history re-derivation first", tone: "negative" });
      return;
    }
    setSaving(true);
    void editAccountAction({
      accountId: account.id,
      name,
      institutionId,
      last4,
      type,
      subtype: effectiveSubtype,
      confirmRederive,
    }).then((r) => {
      setSaving(false);
      if (!r.ok) {
        toast({ title: r.error, tone: "negative" });
        return;
      }
      toast({ title: r.data.rederived ? "Account updated — balance history re-derived" : "Account updated" });
      onClose();
      startTransition(() => router.refresh());
    });
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title="Edit account"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} pending={saving || pending}>
            Save changes
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <Field label="Account name">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
            }}
            autoFocus
          />
        </Field>
        <Field label="Institution">
          <Select value={institutionId} onChange={(e) => setInstitutionId(e.target.value)}>
            {institutions.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Last 4 (optional)" hint="Leave blank to clear.">
          <Input
            value={last4}
            onChange={(e) => setLast4(e.target.value)}
            placeholder="1234"
            inputMode="numeric"
            pattern="\d{4}"
            className="figures"
          />
        </Field>
        <Field label="Type">
          <Select
            value={type}
            onChange={(e) => {
              setType(e.target.value as AccountType);
              // a NEW semantic target needs a fresh confirmation — never carry
              // a checked box across type flips (or a flip-back-and-forth)
              setConfirmRederive(false);
            }}
          >
            {ACCOUNT_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABELS[t]}
              </option>
            ))}
          </Select>
        </Field>
        {type === "investment" ? (
          <Field label="Subtype">
            <Select
              value={subtype}
              onChange={(e) => {
                setSubtype(e.target.value as AccountSubtype | "");
                setConfirmRederive(false);
              }}
            >
              <option value="">—</option>
              {ACCOUNT_SUBTYPES.map((s) => (
                <option key={s} value={s}>
                  {SUBTYPE_LABELS[s]}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
        {/* persistent polite live region — the warning is announced when it
            appears (a conditionally-mounted live region would be missed) */}
        <div aria-live="polite">
          {semanticsChanged ? (
            <div className="space-y-2 rounded-(--radius-card) border border-warning/40 bg-warning/10 p-3">
              <p className="text-xs text-ink">
                {type !== account.type ? "Changing the type" : "Changing the subtype"} re-derives
                this account&apos;s entire balance history — liability math and the balance curve
                follow the type. Nothing is deleted; the history is recomputed from the
                account&apos;s recorded data.
              </p>
              <Checkbox
                label="I understand — re-derive the balance history"
                checked={confirmRederive}
                onChange={(e) => setConfirmRederive(e.target.checked)}
              />
            </div>
          ) : null}
        </div>
      </div>
    </Sheet>
  );
}
