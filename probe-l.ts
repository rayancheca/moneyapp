/** READ-ONLY: merchant category-mix shares + net-worth bridge band shares. */
import { sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { merchantIntelligence } from "@/services/merchants";
import { sharePercent } from "@/lib/insight-facts";

const db = getDb();
const ids = db.all<{ id: string; name: string }>(sql`SELECT id, canonical_name AS name FROM merchants`);
let multi = 0; const odd: string[] = []; const hundreds: string[] = [];
for (const m of ids) {
  let intel: any;
  try { intel = merchantIntelligence(db, m.id, "2026-09-11"); } catch { continue; }
  const mix = intel?.profile?.categoryMix ?? [];
  if (mix.length < 2) continue;
  multi++;
  const sumPct = mix.reduce((s: number, c: any) => s + c.pct, 0);
  if (Math.abs(sumPct - 100) > 0.01) odd.push(`${m.name}: pct sums to ${sumPct.toFixed(3)}`);
  const neg = mix.filter((c: any) => c.pct < 0);
  if (neg.length) odd.push(`${m.name}: NEGATIVE slice ${neg.map((c: any) => `${c.name} ${c.pct}%`).join(", ")}`);
  const shares = mix.map((c: any) => c.share);
  if (shares.includes("0.0%")) odd.push(`${m.name}: a "0.0%" slice among ${shares.join(" + ")}`);
  if (shares.includes("100.0%") && mix.length > 1) hundreds.push(`${m.name}: ${shares.join(" + ")}`);
  // sanity: share must be the display of pct
  for (const c of mix) if (c.share !== sharePercent(c.pct)) odd.push(`${m.name}/${c.name}: share "${c.share}" != sharePercent(${c.pct})`);
}
console.log(`merchants with a multi-category mix: ${multi}`);
console.log(odd.length ? odd.slice(0, 15).join("\n") : "no anomalies");
console.log(hundreds.length ? `100.0% over a sibling:\n${hundreds.join("\n")}` : "no 100.0% over a nonzero sibling");
