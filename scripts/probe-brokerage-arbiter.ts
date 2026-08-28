/**
 * READ-ONLY. Pass 73's question: does the app's holdings-derived market value
 * for `Robinhood Brokerage` agree with what the statements PRINT?
 *
 * Two comparisons, because they answer different questions:
 *   1. printed `Total Securities` vs the SUM OF THE STATEMENT'S OWN holdings
 *      table — is the document internally consistent?
 *   2. printed `Total Securities` vs `portfolioSeries` — does the LEDGER agree
 *      with the document?
 */
import fs from "node:fs";
import path from "node:path";
import { getDb } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { eq } from "drizzle-orm";
import { extractLines } from "@/services/import/profiles/pdf-profile";
import { parseAmountToCents } from "@/lib/money";
import { portfolioSeries } from "@/services/portfolio";

const dir = "data/statements/robinhood-cash";
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".pdf")).sort();
const PERIOD = /(\d{2})\/(\d{2})\/(\d{4}) to (\d{2})\/(\d{2})\/(\d{4})/;
const TOTAL_SEC = /^Total Securities\s*\*{0,3}\s*(\(?\$[\d,]+\.\d{2}\)?|N\/A)\s+(\(?\$[\d,]+\.\d{2}\)?|N\/A)/;
const HOLDING = /^([A-Z][A-Z.]{0,6})\s+(?:Margin|Cash)\s+[\d.]+\s+\$[\d,]+\.\d{2,6}\s+\$([\d,]+\.\d{2})\s/;

const db = getDb();
const acct = db.select().from(accounts).where(eq(accounts.name, "Robinhood Brokerage")).get()!;
const series = new Map(portfolioSeries(db, [acct.id]).map((p) => [p.day, p.valueCents]));

interface Row { end: string; open: number; close: number; summed: number; derived: number | null }
const rows: Row[] = [];
for (const f of files) {
  const lines = (await extractLines(fs.readFileSync(path.join(dir, f)))).map((l) => l.text);
  const p = lines.map((t) => PERIOD.exec(t)).find(Boolean);
  if (!p) continue;
  const end = `${p[6]}-${p[4]}-${p[5]}`;
  const firstPortfolio = lines.findIndex((t) => /^Portfolio Summary/.test(t));
  const region = firstPortfolio < 0 ? lines : lines.slice(0, firstPortfolio);
  const m = region.map((t) => TOTAL_SEC.exec(t)).find(Boolean);
  if (!m || m[1] === "N/A" || m[2] === "N/A") continue;
  let summed = 0;
  for (const t of lines) {
    const h = HOLDING.exec(t);
    if (h) summed += parseAmountToCents(`$${h[2]!}`)!;
  }
  rows.push({
    end,
    open: parseAmountToCents(m[1]!)!,
    close: parseAmountToCents(m[2]!)!,
    summed,
    derived: series.get(end) ?? null,
  });
}
rows.sort((a, b) => a.end.localeCompare(b.end));

const money = (v: number | null) => (v === null ? "        —" : `$${(v / 100).toFixed(2)}`.padStart(12));
console.log(`${rows.length} statements carry a printed Total Securities\n`);
console.log(`period end     printed     doc-summed        diff      ledger-derived        diff`);
let docExact = 0, ledgerExact = 0, ledgerWithin = 0, ledgerOff = 0, missing = 0;
let worst = { end: "", diff: 0 };
for (const r of rows) {
  const docDiff = r.summed - r.close;
  if (docDiff === 0) docExact += 1;
  const led = r.derived === null ? null : r.derived - r.close;
  if (led === null) missing += 1;
  else if (led === 0) ledgerExact += 1;
  else if (Math.abs(led) <= 1) ledgerWithin += 1;
  else {
    ledgerOff += 1;
    if (Math.abs(led) > Math.abs(worst.diff)) worst = { end: r.end, diff: led };
  }
  console.log(
    `${r.end}  ${money(r.close)}  ${money(r.summed)}  ${money(docDiff)}   ${money(r.derived)}  ${led === null ? "        —" : money(led)}`,
  );
}
console.log(`\ndocument internally consistent: ${docExact} of ${rows.length}`);
console.log(`ledger vs printed: exact ${ledgerExact} · within a cent ${ledgerWithin} · diverges ${ledgerOff} · no derived value ${missing}`);
if (worst.end) console.log(`worst divergence: ${money(worst.diff)} on ${worst.end}`);
