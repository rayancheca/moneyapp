"use client";

import { useState } from "react";
import { IconButton } from "@/components/ui/Button";
import { Sheet } from "@/components/ui/Sheet";
import { HoldingForm } from "./HoldingForm";
import { RefreshPricesButton } from "./RefreshPricesButton";

interface HoldingAccount {
  id: string;
  name: string;
  subtype: string | null;
}

/**
 * The portfolio's `⋯` actions (ux-overhaul-plan §6.3): add/update a holding and
 * refresh prices, moved off the main surface into a sheet so the screen leads
 * with the chart and holdings, not the forms.
 */
export function HoldingActionsMenu({
  accounts,
  defaultDate,
}: {
  accounts: HoldingAccount[];
  defaultDate: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <IconButton icon="more" aria-label="Portfolio actions" onClick={() => setOpen(true)} />
      <Sheet open={open} onClose={() => setOpen(false)} title="Portfolio actions">
        <div className="space-y-6">
          <section>
            <div className="mb-3 flex items-center justify-between gap-3">
              <h3 className="text-sm font-medium">Prices</h3>
              <RefreshPricesButton />
            </div>
            <p className="text-xs text-ink-muted">
              Backfills missing daily closes, quotes today, and re-anchors net worth.
            </p>
          </section>
          <section>
            <h3 className="mb-3 text-sm font-medium">Add or update a holding</h3>
            <HoldingForm accounts={accounts} defaultDate={defaultDate} />
          </section>
        </div>
      </Sheet>
    </>
  );
}
