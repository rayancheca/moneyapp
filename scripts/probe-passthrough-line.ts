/** READ-ONLY. Proves the renamed category and the renamed lookup agree on the real ledger. */
import { getDb } from "@/db/client";
import { yearSummaryView } from "@/services/year-summary";
const db = getDb();
for (const year of [2024, 2025, 2026]) {
  const v = yearSummaryView(db, year, "2026-08-25");
  const line = v.summary.sections.flatMap((s) => s.lines).find((l) => l.id === "passthrough");
  console.log(
    `${year}: ` +
      (line
        ? `${line.label} $${(line.amountCents / 100).toFixed(2)} over ${line.rowCount} rows` +
          (line.counterLabel ? ` · ${line.counterLabel} $${((line.counterCents ?? 0) / 100).toFixed(2)}` : "")
        : "no pass-through line") +
      `  | excluded $${(v.summary.excludedCents / 100).toFixed(2)}  earned $${(v.summary.earnedCents / 100).toFixed(2)}`,
  );
}
