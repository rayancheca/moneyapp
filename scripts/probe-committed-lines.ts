/** READ-ONLY. What the runway card's committed book knows per line. */
import { getDb } from "@/db/client";
import { runwayCard } from "@/services/committed";
import { recurringSeries } from "@/db/schema";
import { inArray } from "drizzle-orm";
import { levelledMonthlyCents } from "@/lib/income-basis";

const db = getDb();
const TODAY = process.env.PROBE_TODAY ?? "2026-09-02";
const c = runwayCard(db, TODAY);
const rows = db.select().from(recurringSeries).where(inArray(recurringSeries.status, ["detected", "confirmed"])).all();
const byId = new Map(rows.map((r) => [r.id, r]));
console.log(`months=${c.committed.months ?? "?"} total=$${(c.committed.totalCents/100).toFixed(2)} perMonth=$${(c.committed.perMonthCents/100).toFixed(2)}`);
let levelledSum = 0;
for (const l of c.committed.lines) {
  const s = byId.get(l.seriesId);
  const cadence = s?.userCadence ?? s?.cadence ?? "?";
  const per = Math.abs(s?.nextExpectedAmountCents ?? 0);
  const levelled = per > 0 ? levelledMonthlyCents(per, cadence as never) : 0;
  levelledSum += levelled;
  const short = levelled - l.perMonthCents;
  console.log(
    `${l.name.padEnd(32)} occ=${String(l.occurrences).padStart(2)} total=$${(l.totalCents/100).toFixed(2).padStart(10)}` +
    ` perMonth=$${(l.perMonthCents/100).toFixed(2).padStart(9)} levelled=$${(levelled/100).toFixed(2).padStart(9)}` +
    ` short=$${(short/100).toFixed(2).padStart(8)} cadence=${cadence} endsOn=${s?.userEndsOn ?? "-"}`,
  );
}
console.log(`levelled sum = $${(levelledSum/100).toFixed(2)}  vs perMonth $${(c.committed.perMonthCents/100).toFixed(2)}  gap $${((levelledSum - c.committed.perMonthCents)/100).toFixed(2)}`);
