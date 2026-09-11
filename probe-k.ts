/** READ-ONLY: apportion edge cases + merchant category-mix shares + cards-owed row shares. */
import { getDb } from "@/db/client";
import { apportionPercents } from "@/lib/apportion";
import { sharePercent, renderPercent } from "@/lib/insight-facts";
import { merchantIntelligence } from "@/services/merchants";
import { merchants } from "@/db/schema/merchants";
import { cardsOwedCard } from "@/services/cards-owed";

console.log("== apportionPercents edge cases ==");
const cases: [string, number[]][] = [
  ["empty", []],
  ["single 100", [100]],
  ["single 94.33", [94.334172]],
  ["single 0.4", [0.4]],
  ["all zero", [0, 0, 0]],
  ["three thirds", [100 / 3, 100 / 3, 100 / 3]],
  ["the dashboard four", [50.888497, 21.68417, 19.976802, 1.784702]],
  ["two 0.9s", [0.9, 0.9]],
  ["ten tenths", Array.from({ length: 10 }, () => 9.99)],
  ["one part 0", [0]],
  ["99.9 + 0.1", [99.9, 0.1]],
  ["sums to 99.4", [33.1, 33.1, 33.2]],
  ["a negative part", [-1.4, 50.4, 51.0]],
  ["101 parts of ~1", Array.from({ length: 101 }, () => 0.990099)],
];
for (const [label, parts] of cases) {
  let out: number[] | string;
  try { out = apportionPercents(parts); } catch (e) { out = `THREW ${e}`; }
  const target = Math.round(parts.reduce((s, p) => s + p, 0));
  const sum = Array.isArray(out) ? out.reduce((s, p) => s + p, 0) : NaN;
  const maxMove = Array.isArray(out) ? Math.max(0, ...out.map((o, i) => Math.abs(o - parts[i]!))) : NaN;
  console.log(`  ${label.padEnd(22)} -> ${Array.isArray(out) ? `[${out.join(", ")}]` : out}  sum=${sum} target=${target} ${sum === target ? "OK" : "!! MISMATCH"} maxMove=${maxMove.toFixed(3)}${maxMove >= 1.000001 ? " !! MOVED >1pt" : ""}`);
}

console.log("\n== renderPercent on negatives (the mirror the rule does not cover) ==");
for (const p of [-0.04, -0.001, -99.96, -100, 0.04, 99.96, 100]) console.log(`  sharePercent(${p}) = "${sharePercent(p)}"`);

console.log("\n== merchant category mix ==");
const db = getDb();
const ms = db.select({ id: merchants.id, name: merchants.name }).from(merchants).all();
let multi = 0; const odd: string[] = [];
for (const m of ms) {
  let intel: any;
  try { intel = merchantIntelligence(db, m.id, "2026-09-11"); } catch { continue; }
  const mix = intel?.profile?.categoryMix ?? [];
  if (mix.length < 2) continue;
  multi++;
  const sumPct = mix.reduce((s: number, c: any) => s + c.pct, 0);
  const neg = mix.filter((c: any) => c.pct < 0);
  if (Math.abs(sumPct - 100) > 0.01) odd.push(`${m.name}: pct sums to ${sumPct.toFixed(3)}`);
  if (neg.length) odd.push(`${m.name}: NEGATIVE slice ${neg.map((c: any) => `${c.name} ${c.pct.toFixed(3)}% -> "${c.share}"`).join(", ")}`);
  const shares = mix.map((c: any) => c.share);
  if (shares.some((s: string) => s === "0.0%" || s === "100.0%") && mix.length > 1) odd.push(`${m.name}: ${shares.join(" + ")}`);
}
console.log(`  merchants with a multi-category mix: ${multi}`);
console.log(odd.length ? odd.slice(0, 15).join("\n") : "  no anomalies");

console.log("\n== cards-owed row shares ==");
const c = cardsOwedCard(db, "2026-09-11");
let s = 0;
for (const card of (c as any).cards) if (card.shareLabel) { console.log(`  ${card.name.padEnd(22)} ${String(card.sharePct?.toFixed(4)).padStart(10)}%  "${card.shareLabel}"`); s += Number(String(card.shareLabel).match(/\d+/)?.[0] ?? 0); }
console.log(`  rows add to ${s}%`);
