"use client";

import { useState } from "react";
import { IconButton } from "@/components/ui/Button";
import { Sheet } from "@/components/ui/Sheet";
import { HoldingForm } from "./HoldingForm";

interface HoldingAccount {
  id: string;
  name: string;
  subtype: string | null;
}

/**
 * The portfolio's `⋯` actions (ux-overhaul-plan §6.3): add/update a holding,
 * moved off the main surface into a sheet so the screen leads with the chart and
 * holdings, not the forms. Price refresh used to live here too and is now a
 * first-class button in the page header — see the note below.
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
          {/* "Prices" used to live here with its own Refresh button. It moved out
              to the page header, beside this menu, because a control for
              something that goes stale by itself should not be two clicks deep.
              The explanation it carried now rides on that button's tooltip. */}
          <section>
            <h3 className="mb-3 text-sm font-medium">Add or update a holding</h3>
            <HoldingForm accounts={accounts} defaultDate={defaultDate} />
          </section>
        </div>
      </Sheet>
    </>
  );
}
