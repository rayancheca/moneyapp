import { countPhrase, type BlastRadius, type BlastRadiusLine } from "@/components/ui/blast-radius";
import { dayWindowLabel } from "@/lib/period";
import type { AnchorRemovalEffect } from "@/services/anchors";
import type { LostDayFates, RemovalEffect } from "@/services/derivation";

/**
 * The /accounts/[id] "Remove this balance" confirmation, read off what removal
 * actually changes (`anchorRemovalEffects`, which derives the account with and
 * without the balance) — never a date range worked out on the page. The count's
 * measured history lives on `removalEffect` in services/derivation.
 *
 * ⛔ Each sentence says only what its effect proves, and the effect now carries
 * enough to prove each one. What was printed before, and was not true:
 *
 * 🔴 "Removing it leaves those days to be derived from transactions alone" on
 * every lost day, whatever became of it. Measured 2026-09-14: Cash on Hand holds
 * ONE balance, so the dialog read "This balance is what verifies Cash on Hand on
 * Aug 3 – 10, 2026. Removing it leaves those days to be derived from
 * transactions alone. … the balance curve is derived, so it rebuilds from what is
 * left" over a removal that leaves 0 rows of 43. Every cash wallet starts that
 * way (`createCashWallet` seeds one opening balance). A lost day can stay as a
 * replay nobody checks, turn into a gap, or lose its balance entirely, and
 * `lostTo` says which.
 *
 * 🔴 "Removing it leaves the curve exactly as it is" over Robinhood Cash and Chase
 * Sapphire, whose stored curves ended 2026-08-28 and 2026-09-03. Confirming
 * rebuilds through today and added 17 and 11 days. The headline now claims only
 * what the balance does; `catchUpDays` gets its own line.
 *
 * 🔴 "This balance pins no day … that another balance does not already pin" over a
 * manual $120.00 above a quiet $100.00 statement: it alone set four verified days
 * at $120.00, and they re-base to $100.00 without it. `rebasedDays` branches that.
 *
 * 🔴 A first-to-last window over lost days with a hole in it, beside a smaller
 * count: "Jun 7 – 26, 2026" and "19 days". Runs that break read as a count
 * within the window.
 *
 * 🔴 "Record the balance again to re-verify these days" under "Days that stop
 * being verified: no days" — three of the four such dialogs on the ledger.
 */
export interface RemoveBalanceInput {
  accountName: string;
  effect: AnchorRemovalEffect;
  /** the balance as recorded, already in the owner's frame (`balanceHeading` → formatted) */
  recorded: { label: string; value: string };
  /** recorded balances the account keeps once this one goes */
  balancesLeft: number;
}

export function removeBalanceRadius(input: RemoveBalanceInput): BlastRadius {
  const { effect } = input;
  return {
    headline: removeBalanceHeadline(input.accountName, effect),
    lines: [
      { label: `${input.recorded.label}, as recorded`, value: input.recorded.value, irreversible: true },
      {
        label: "Days that stop being verified",
        value: effect.pricedFromHoldings
          ? "none — the curve comes from holdings"
          : countPhrase(effect.lostDays, "day"),
      },
      ...catchUpLines(effect),
      { label: "Recorded balances left on this account", value: countPhrase(input.balancesLeft, "balance") },
    ],
    reassurance: removeBalanceReassurance(effect),
  };
}

function removeBalanceHeadline(name: string, effect: AnchorRemovalEffect): string {
  if (effect.pricedFromHoldings) {
    return `${name} is priced from its holdings, so this recorded balance verifies nothing and plays no part in its curve.`;
  }
  const verifies = effect.lostDays > 0 ? `This balance is what verifies ${name} on ${lostPlace(effect)}. ` : "";
  if (effect.daysLeft === 0) {
    return `${verifies}It is the only balance ${name} has, so removing it leaves nothing to derive a curve from, and every day comes off it.`;
  }
  if (effect.lostDays > 0) {
    const rebased =
      effect.rebasedDays > 0 ? ` It also sets the balance on ${countPhrase(effect.rebasedDays, "other verified day")}.` : "";
    return `${verifies}${lostFate(effect)}${rebased}`;
  }
  if (effect.curveUnchanged) {
    return `This balance pins no day of ${name} that another balance does not already pin. Without it, every day keeps the same balance and the same verification.`;
  }
  if (effect.rebasedDays > 0) {
    return `No day of ${name} stops being verified without this balance, but it sets the balance on ${countPhrase(effect.rebasedDays, "verified day")}, so removing it re-derives ${countPhrase(effect.changedDays, "day")} from the balances around it.`;
  }
  return `This balance pins no day of ${name} that another balance does not already pin, but removing it re-derives ${countPhrase(effect.changedDays, "day")} from the balances around it.`;
}

/** One run names its window; runs with a hole between them are a count within it. */
function lostPlace(effect: RemovalEffect): string {
  const first = effect.lostRuns[0]!;
  const last = effect.lostRuns.at(-1)!;
  const window = dayWindowLabel(first.from, last.to);
  return effect.lostRuns.length === 1 ? window : `${countPhrase(effect.lostDays, "day")} within ${window}`;
}

/** What becomes of a lost day, in the order the sentence lists them. */
const LOST_DAY_FATE: Record<keyof LostDayFates, string> = {
  unverified: "to be derived from transactions alone",
  gap: "as a gap",
  gone: "with no balance at all",
};

/** When every lost day shares a fate, the gap says why a gap is a gap. */
const GAP_BECAUSE = ": the balances either side no longer agree with the transactions between them";

function lostFate(effect: RemovalEffect): string {
  const { lostTo } = effect;
  const fates = (Object.keys(LOST_DAY_FATE) as (keyof LostDayFates)[]).filter((k) => lostTo[k] > 0);
  const [only] = fates;
  if (fates.length === 1 && only !== undefined) {
    const them = effect.lostDays === 1 ? "that day" : "those days";
    return `Removing it leaves ${them} ${LOST_DAY_FATE[only]}${only === "gap" ? GAP_BECAUSE : ""}.`;
  }
  const parts = fates.map((k) => `${countPhrase(lostTo[k], "day")} ${LOST_DAY_FATE[k]}`);
  return `Removing it leaves ${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}.`;
}

/**
 * The rebuild confirming triggers also catches a stale curve up to today — true
 * whichever balance goes, so it is its own line and never folded into the
 * balance's count. Not said when nothing is left: every day comes off instead.
 */
function catchUpLines(effect: AnchorRemovalEffect): BlastRadiusLine[] {
  if (effect.pricedFromHoldings || effect.daysLeft === 0 || effect.catchUpDays === 0) return [];
  return [
    {
      label: "Days rebuilt up to today, with or without this balance",
      value: countPhrase(effect.catchUpDays, "day"),
    },
  ];
}

function removeBalanceReassurance(effect: AnchorRemovalEffect): string {
  if (effect.pricedFromHoldings) {
    return "No transaction and no holding is touched — this account's value history is rebuilt from its holdings and their stored closes, which this balance is not part of.";
  }
  if (effect.daysLeft === 0) {
    return "No transaction is touched. Record a balance again and the curve is derived from it and the transactions.";
  }
  const rebuilds = "No transaction is touched — the balance curve is derived, so it rebuilds from what is left.";
  return effect.lostDays > 0 ? `${rebuilds} Record the balance again to re-verify these days.` : rebuilds;
}
