"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { editAccountAction } from "@/app/accounts/actions";
import { Button } from "@/components/ui/Button";
import { Field, Input, Select } from "@/components/ui/Field";
import { Sheet } from "@/components/ui/Sheet";
import { toast } from "@/components/ui/Toast";

export interface EditableAccount {
  id: string;
  name: string;
  institutionId: string;
  last4: string | null;
  typeLabel: string;
}

/**
 * Edit-account sheet (ux-overhaul-plan §7.2): rename, re-home to another
 * institution, fix the last4 — the three edits that used to need raw SQL. Type
 * and subtype are intentionally shown read-only: changing them rewrites the
 * balance curve, so that stays out of a casual rename.
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

  function save(): void {
    void editAccountAction({ accountId: account.id, name, institutionId, last4 }).then((r) => {
      if (!r.ok) {
        toast({ title: r.error, tone: "negative" });
        return;
      }
      toast({ title: "Account updated" });
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
          <Button onClick={save} pending={pending}>
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
        <p className="text-xs text-ink-faint">
          Type: <span className="text-ink-muted">{account.typeLabel}</span> — change an account&apos;s type
          from its detail page; it rewrites the balance history.
        </p>
      </div>
    </Sheet>
  );
}
