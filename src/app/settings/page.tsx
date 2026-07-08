import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";

export const metadata: Metadata = { title: "Settings" };

export default function SettingsPage() {
  return (
    <>
      <PageHeader
        title="Settings"
        description="AI spend cap, review thresholds, price staleness, backups, week start."
      />
      <EmptyState
        title="Defaults are active"
        description="Seeded defaults: $5/month AI cap, $200 credit-review threshold, 4-hour price staleness, ISO weeks, 14 daily + 6 monthly backups. The editing surface ships with the categorization module."
        phase="Phase 3 · Categorization"
      />
    </>
  );
}
