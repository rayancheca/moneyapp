/** READ-ONLY exploration. */
import { inArray } from "drizzle-orm";
import { getDb } from "@/db/client";
import { recurringSeries } from "@/db/schema/recurring";
import { formatCents } from "@/lib/money";
import {
  annualizedCentsOf,
  effectiveSeries,
  lapsedSeriesShouldStopForecasting,
  rollForwardNextExpected,
  seriesHasLapsed,
  seriesStaleness,
  upcomingOccurrences,
} from "@/services/recurring";

const TODAY = "2026-08-26";
const db = getDb();

const rows = db
  .select()
  .from(recurringSeries)
  .where(inArray(recurringSeries.status, ["detected", "confirmed"]))
  .all();

console.log(`live-status series: ${rows.length}`);
for (const s of rows) {
  const eff = effectiveSeries(s);
  const st = seriesStaleness(s, TODAY);
  const ann = annualizedCentsOf(eff);
  const lapsed = seriesHasLapsed(s, TODAY);
  const stops = lapsedSeriesShouldStopForecasting(s.kind);
  const next = rollForwardNextExpected(eff, TODAY);
  console.log(
    [
      s.name.padEnd(38).slice(0, 38),
      s.kind.padEnd(12),
      eff.cadence.padEnd(10),
      (ann === null ? "—" : formatCents(Math.round(ann / 12))).padStart(11),
      `last=${s.lastMatchedOn ?? "never"}`,
      `d=${st.daysSinceLastMatch ?? "—"}/${st.toleranceDays.toFixed(1)}`,
      `stale=${st.isStale ? "Y" : "n"}`,
      `lapsed=${lapsed ? "Y" : "n"}`,
      `stops=${stops ? "Y" : "n"}`,
      `next=${next ?? "—"}`,
      `ends=${s.userEndsOn ?? "—"}`,
    ].join("  "),
  );
}

const occ = upcomingOccurrences(db, TODAY, 365);
const forecastIds = new Set(occ.map((o) => o.seriesId));
console.log("\nseries ids appearing in upcomingOccurrences(365):", forecastIds.size);
for (const s of rows) {
  console.log(`  ${forecastIds.has(s.id) ? "FORECAST" : "silent  "}  ${s.name}`);
}
