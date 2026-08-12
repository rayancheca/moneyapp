"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { setBudgetRolloverAction, updateBudgetPeriodAction } from "@/app/budgets/actions";
import { Select } from "@/components/ui/Field";
import { InlineEditableText } from "@/components/ui/InlineEditableText";
import { Money } from "@/components/ui/Money";
import { toast } from "@/components/ui/Toast";
import { BUDGET_PERIODS, type BudgetPeriodKind } from "@/db/schema/budgets";
import { formatDayShort } from "@/lib/format-date";
import { formatCents, parseAmountToCents } from "@/lib/money";
import type { BudgetPaceStatus } from "@/services/budgets";
import { PERIOD_WORD } from "./BudgetAmountEditor";

const PERIOD_LABEL: Record<BudgetPeriodKind, string> = {
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
  annual: "Annual",
};

interface BudgetDetailsProps {
  status: BudgetPaceStatus;
  /** lifted out of the toggle so this panel reacts before the server round-trip */
  rolloverEnabled: boolean;
}

/**
 * What a budget row reveals when you open it: the terms behind its headline, and
 * the settings that previously had no home at all.
 *
 * The period and the two rollover knobs are here rather than on the collapsed row
 * because they are decisions, not readings — you set them once and then spend
 * months looking at the bar. The collapsed row stays a scan-line.
 *
 * ⛔ Nothing in here may render a button named exactly "Save": two e2e specs click
 * `getByRole("button", { name: "Save" })` UNSCOPED and the inline amount editor is
 * the only match today, so a second one is a strict-mode throw. The period is a
 * native <select> committing on change, and both text editors commit on
 * blur/Enter.
 */
export function BudgetDetails({ status, rolloverEnabled }: BudgetDetailsProps) {
  const router = useRouter();
  const { budget } = status;
  const [pending, startTransition] = useTransition();
  const [period, setPeriod] = useState<BudgetPeriodKind>(budget.period);

  function changePeriod(next: BudgetPeriodKind): void {
    const previous = period;
    setPeriod(next);
    startTransition(async () => {
      const r = await updateBudgetPeriodAction({ budgetId: budget.id, period: next });
      if (!r.ok) {
        setPeriod(previous);
        toast({ title: r.error, tone: "negative" });
        return;
      }
      toast({ title: `${status.categoryPath} is now a ${PERIOD_LABEL[next].toLowerCase()} budget` });
      router.refresh();
    });
  }

  /** Shared writer for the two rollover knobs — `enabled` is never changed here. */
  async function writeRollover(
    patch: { startsOn?: string | null; capCents?: number | null },
    describe: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const r = await setBudgetRolloverAction({
      budgetId: budget.id,
      enabled: rolloverEnabled,
      ...patch,
    });
    if (r.ok) {
      toast({ title: describe });
      router.refresh();
    }
    return { ok: r.ok, error: r.ok ? undefined : r.error };
  }

  return (
    <div className="mt-3 space-y-3 border-t border-line pt-3 text-xs">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <label className="flex items-center gap-2">
          <span className="text-ink-faint">Period</span>
          <Select
            fieldSize="sm"
            value={period}
            disabled={pending}
            aria-label={`${status.categoryPath} budget period`}
            onChange={(e) => changePeriod(e.target.value as BudgetPeriodKind)}
          >
            {BUDGET_PERIODS.map((p) => (
              <option key={p} value={p}>
                {PERIOD_LABEL[p]}
              </option>
            ))}
          </Select>
        </label>
        <span className="text-ink-faint">
          {formatCents(budget.amountCents)} / {PERIOD_WORD[period]} · started{" "}
          {formatDayShort(budget.startsOn)}
        </span>
      </div>

      {/* The window this row is graded over, stated plainly. `partialPeriod` means
          the budget did not exist for the whole period, which is why its bar can
          look generous next to a full month of spending. */}
      <p className="text-ink-muted">
        Grading {formatDayShort(status.bounds.start)} – {formatDayShort(status.bounds.end)}
        {status.partialPeriod && " — this budget started mid-period, so only its own days count"}
        {status.dataThroughOn
          ? ` · spending imported through ${formatDayShort(status.dataThroughOn)}`
          : " · nothing imported for this category yet"}
      </p>

      {rolloverEnabled ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <span className="text-ink-faint">Carry from</span>
            <InlineEditableText
              value={budget.rolloverStartsOn ?? budget.startsOn}
              label={`${status.categoryPath} rollover start date`}
              placeholder="YYYY-MM-DD"
              className="text-xs"
              onSave={(next) => writeRollover({ startsOn: next.trim() }, "Rollover start updated")}
            />
            <span className="text-ink-faint">Cap</span>
            <InlineEditableText
              value={budget.rolloverCapCents === null ? "" : formatCents(budget.rolloverCapCents)}
              label={`${status.categoryPath} rollover cap`}
              placeholder="none"
              required={false}
              className="text-xs"
              onSave={async (next) => {
                const raw = next.trim();
                if (raw === "") return writeRollover({ capCents: null }, "Rollover cap removed");
                let cents: number;
                try {
                  cents = parseAmountToCents(raw);
                } catch {
                  return { ok: false, error: "That amount didn't parse — try 500 or 1,250.00" };
                }
                return writeRollover({ capCents: cents }, `Rollover capped at ${formatCents(cents)}`);
              }}
            />
          </div>
          <p className="text-ink-faint">
            Banked <Money cents={status.rolloverCents} /> from closed periods. A period that came in
            under plan adds its leftover; one that went over adds nothing, and overspend is never
            carried as a debt. Bills that came due and never posted are subtracted, so a missing
            statement cannot bank itself as savings.
          </p>
        </div>
      ) : (
        <p className="text-ink-faint">
          Leftover is forgotten at the end of each {PERIOD_WORD[period]}. Turn on “Roll over” to bank
          it instead — useful for lumpy spending like travel, where one month funds the next.
        </p>
      )}
    </div>
  );
}
