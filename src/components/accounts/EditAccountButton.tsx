"use client";

import { useState } from "react";
import { EditAccountSheet, type EditableAccount, type FundingCandidate } from "./EditAccountSheet";

/**
 * Opens the edit-account sheet from the account detail page — so the name (and
 * institution / last4) is editable everywhere the account is shown, not only in
 * the /accounts manage list (nothing read-only).
 */
export function EditAccountButton({
  account,
  institutions,
  fundingCandidates = [],
}: {
  account: EditableAccount;
  institutions: readonly { id: string; name: string }[];
  fundingCandidates?: readonly FundingCandidate[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="shrink-0 rounded-full border border-line px-3 py-1 text-xs font-medium text-ink-muted transition-[color,background-color,transform] duration-(--duration-fast) hover:border-line-strong hover:text-ink active:scale-95"
      >
        Edit account
      </button>
      {open && (
        <EditAccountSheet
          account={account}
          institutions={institutions}
          fundingCandidates={fundingCandidates}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
