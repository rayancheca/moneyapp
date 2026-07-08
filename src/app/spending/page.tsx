import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";

export const metadata: Metadata = { title: "Spending" };

export default function SpendingPage() {
  return (
    <>
      <PageHeader
        title="Spending & income"
        description="Category breakdowns, trends, and income tracking — transfers and rewards excluded by construction."
      />
      <EmptyState
        title="No data to analyze yet"
        description="Analytics unlock after ingestion and categorization. Every number will reconcile exactly to a visible transaction list."
        phase="Phase 4 · Analytics"
      />
    </>
  );
}
