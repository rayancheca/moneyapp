import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";

export const metadata: Metadata = { title: "Investments" };

export default function InvestmentsPage() {
  return (
    <>
      <PageHeader
        title="Investments"
        description="Holdings, live prices, gain/loss, and allocation. Market value drives net worth; average cost is for P/L only."
      />
      <EmptyState
        title="No holdings yet"
        description="Holdings entry with free live prices (Yahoo for stocks, Coinbase for ETH) — cached locally so history is fetched exactly once."
        phase="Phase 7 · Holdings & Prices"
      />
    </>
  );
}
