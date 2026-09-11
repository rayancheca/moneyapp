/** READ-ONLY: sweep `today` — annualizedCentsOf vs committedBook's own 12-month line. */
import { getDb } from "@/db/client";
import { addDays } from "@/lib/dates";
import { formatCents } from "@/lib/money";
import { listSeries } from "@/services/recurring";
import { committedBook } from "@/services/committed";

const db = getDb();
const START = "2026-09-01";
const DAYS = 120;
let daysWithDiff = 0;
const detail: string[] = [];
for (let i = 0; i < DAYS; i++) {
  const today = addDays(START, i);
  const views = listSeries(db, today);
  const book: any = committedBook(db, today, 12);
  const lines: any[] = book.lines ?? [];
  const diffs: string[] = [];
  for (const l of lines) {
    const v = views.find((x) => x.id === l.seriesId);
    if (!v || v.annualizedCents === null) continue;
    const book12 = Math.abs(l.totalCents ?? l.horizonCents ?? 0);
    if (book12 !== v.annualizedCents) {
      diffs.push(`${l.name}: committed ${formatCents(book12)} vs annualized ${formatCents(v.annualizedCents)} (Δ ${formatCents(v.annualizedCents - book12)})`);
    }
  }
  if (diffs.length) { daysWithDiff++; if (detail.length < 25) detail.push(`${today}  ${diffs.join(" | ")}`); }
}
console.log(`days swept: ${DAYS} from ${START}; days with a disagreement: ${daysWithDiff}`);
console.log(detail.join("\n"));
