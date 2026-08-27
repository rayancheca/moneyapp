/** READ-ONLY. Every 4-digit year the route permits, against the real ledger. */
import { getDb } from "@/db/client";
import { isValidIsoDate } from "@/lib/dates";
import { yearInsights } from "@/services/year-insights";
const db = getDb();
for (const s of ["99-12-31", "0-12-31", "-1-12-31", "0099-12-31", "0100-12-31"])
  console.log(`isValidIsoDate(${JSON.stringify(s).padEnd(13)}) = ${isValidIsoDate(s)}`);
console.log();
for (const y of [0, 1, 99, 100, 1899, 1900, 2021, 2022, 2023, 2024, 2025, 2026, 2027, 9999]) {
  let out: string;
  try { out = yearInsights(db, y) ? "RENDERS" : "(withheld)"; } catch (e) { out = `THREW: ${(e as Error).message}`; }
  console.log(`${String(y).padStart(4)}: ${out}`);
}
