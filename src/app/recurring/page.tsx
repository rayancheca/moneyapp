import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";

export const metadata: Metadata = { title: "Recurring" };

export default function RecurringPage() {
  return (
    <>
      <PageHeader
        title="Recurring & forecast"
        description="Detected subscriptions, bills, and salary with next expected dates — feeding an inspectable end-of-month forecast."
      />
      <EmptyState
        title="Nothing detected yet"
        description="Detection needs transaction history: stable cadence plus stable amount, at least three occurrences. The math panel will show every input."
        phase="Phase 6 · Recurring + Forecasting"
      />
    </>
  );
}
