import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";

export const metadata: Metadata = { title: "Accounts" };

export default function AccountsPage() {
  return (
    <>
      <PageHeader
        title="Accounts"
        description="Deposit, credit, and investment accounts across your five institutions. Debit cards spend from checking — they don't hold balances."
      />
      <EmptyState
        title="No accounts yet"
        description="Account setup with balance entry ships in the Net Worth module — the first thing being built."
        phase="Phase 1 · Net Worth"
      />
    </>
  );
}
