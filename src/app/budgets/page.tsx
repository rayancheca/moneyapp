import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";

export const metadata: Metadata = { title: "Budgets" };

export default function BudgetsPage() {
  return (
    <>
      <PageHeader
        title="Budgets"
        description="Daily, weekly, monthly, and annual budgets per category. Leftover is visible but never rolls over."
      />
      <EmptyState
        title="No budgets yet"
        description="Budgets build on categorized history so actual-vs-budget is trustworthy from day one."
        phase="Phase 5 · Budgets"
      />
    </>
  );
}
