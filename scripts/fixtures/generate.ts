import fs from "node:fs";
import path from "node:path";
import { addDays, compareDates, monthKey } from "../../src/lib/dates";
import {
  renderCapOne360Csv,
  renderCapOneCardCsv,
  renderChaseCardCsv,
  renderChaseDepositCsv,
  renderChaseQfx,
  renderCapOneOfx,
  renderDiscoverCsv,
  renderRobinhoodActivityCsv,
  renderSofiCsv,
  balanceAt,
} from "./render";
import { renderSofiCombinedPdf, renderStatementPdf } from "./render-pdf";
import { runSimulation, SIM_END, SIM_START, type AccountKey } from "./simulate";

/**
 * Writes the synthetic fixture set to tests/fixtures/synthetic/, mirroring
 * each institution's REAL export availability (research digest):
 * Chase CSV+QFX in 3-month chunks over 24mo; Discover CSV last 12mo only;
 * Capital One structured last ~90 days only; SoFi CSV full 2y (no balances);
 * Robinhood activity CSV full-range (brokerage only); monthly statement PDFs
 * everywhere — the anchors the backfill depends on.
 */

const OUT = path.join(process.cwd(), "tests", "fixtures", "synthetic");

async function main(): Promise<void> {
  const sim = runSimulation();
  fs.rmSync(OUT, { recursive: true, force: true });
  for (const inst of ["chase", "discover", "capital-one", "sofi", "robinhood"]) {
    fs.mkdirSync(path.join(OUT, inst, "statements"), { recursive: true });
  }

  const write = (rel: string, contents: string | Uint8Array) => {
    fs.writeFileSync(path.join(OUT, rel), contents);
  };
  const account = (key: AccountKey) => sim.accounts.find((a) => a.key === key)!;
  const txnsOf = (key: AccountKey) => sim.txns.get(key)!;

  // ── Chase: 3-month CSV+QFX chunks over the full 24 months ─────────────
  const chunks: { from: string; to: string }[] = [];
  for (let from = SIM_START; compareDates(from, SIM_END) <= 0; ) {
    const [y, m] = [Number(from.slice(0, 4)), Number(from.slice(5, 7))];
    const nextQ = m + 3 > 12 ? `${y + 1}-${String(m + 3 - 12).padStart(2, "0")}-01` : `${y}-${String(m + 3).padStart(2, "0")}-01`;
    const to = compareDates(addDays(nextQ, -1), SIM_END) <= 0 ? addDays(nextQ, -1) : SIM_END;
    chunks.push({ from, to });
    from = nextQ;
  }
  for (const { from, to } of chunks) {
    const tag = `${from}_${to}`;
    write(`chase/Chase4321_Activity_${tag}.CSV`, renderChaseDepositCsv(txnsOf("chase-checking"), sim.startBalances["chase-checking"], from, to));
    write(`chase/Chase8721_Activity_${tag}.CSV`, renderChaseDepositCsv(txnsOf("chase-savings"), sim.startBalances["chase-savings"], from, to));
    write(`chase/Chase1111_Activity_${tag}.CSV`, renderChaseCardCsv(txnsOf("chase-card"), "1111", from, to));
    write(`chase/Chase4321_Activity_${tag}.QFX`, renderChaseQfx(account("chase-checking"), txnsOf("chase-checking"), from, to, balanceAt(sim, "chase-checking", to)));
    write(`chase/Chase8721_Activity_${tag}.QFX`, renderChaseQfx(account("chase-savings"), txnsOf("chase-savings"), from, to, balanceAt(sim, "chase-savings", to)));
    write(`chase/Chase1111_Activity_${tag}.QFX`, renderChaseQfx(account("chase-card"), txnsOf("chase-card"), from, to, balanceAt(sim, "chase-card", to)));
  }

  // ── Discover: CSV last 12 months only ──────────────────────────────────
  write(
    "discover/Discover-RecentActivity-20260705.csv",
    renderDiscoverCsv(txnsOf("discover-card"), "2025-07-06", SIM_END),
  );

  // ── Capital One: structured exports cover only the last ~90 days ──────
  const capFrom = addDays(SIM_END, -89);
  write(`capital-one/3333_transaction_download.csv`, renderCapOne360Csv(txnsOf("capone-checking"), sim.startBalances["capone-checking"], "3333", capFrom, SIM_END));
  write(`capital-one/4444_transaction_download.csv`, renderCapOneCardCsv(txnsOf("capone-venturex"), "4444", capFrom, SIM_END));
  write(`capital-one/3333_transaction_download.ofx`, renderCapOneOfx(account("capone-checking"), txnsOf("capone-checking"), capFrom, SIM_END, balanceAt(sim, "capone-checking", SIM_END)));
  write(`capital-one/4444_transaction_download.ofx`, renderCapOneOfx(account("capone-venturex"), txnsOf("capone-venturex"), capFrom, SIM_END, balanceAt(sim, "capone-venturex", SIM_END)));

  // ── SoFi: web CSV full range (transactions only, no period balances) ──
  write("sofi/SoFi-Checking-transactions.csv", renderSofiCsv(txnsOf("sofi-checking"), sim.startBalances["sofi-checking"], SIM_START, SIM_END));
  write("sofi/SoFi-Savings-transactions.csv", renderSofiCsv(txnsOf("sofi-savings"), sim.startBalances["sofi-savings"], SIM_START, SIM_END));

  // ── Robinhood: self-serve activity CSV, full account history ──────────
  write("robinhood/robinhood_activity_report.csv", renderRobinhoodActivityCsv(txnsOf("robinhood-brokerage"), SIM_START, SIM_END));

  // ── Monthly statement PDFs for every account (the anchor source) ──────
  const instDir: Record<string, string> = {
    Chase: "chase",
    Discover: "discover",
    "Capital One": "capital-one",
    SoFi: "sofi",
    Robinhood: "robinhood",
  };
  let pdfCount = 0;
  const sofiPeriodsByMonth = new Map<string, { checking?: (typeof sim.periods)[number]; savings?: (typeof sim.periods)[number] }>();

  for (const period of sim.periods) {
    const acct = account(period.accountKey);
    if (acct.institution === "SoFi") {
      const entry = sofiPeriodsByMonth.get(period.periodStart) ?? {};
      if (period.accountKey === "sofi-checking") entry.checking = period;
      else entry.savings = period;
      sofiPeriodsByMonth.set(period.periodStart, entry);
      continue;
    }
    const bytes = await renderStatementPdf(acct, period);
    const name = `${acct.key}-${period.periodStart}_${period.periodEnd}.pdf`;
    write(path.join(instDir[acct.institution]!, "statements", name), bytes);
    pdfCount += 1;
  }
  for (const [start, entry] of sofiPeriodsByMonth) {
    if (!entry.checking || !entry.savings) continue;
    const bytes = await renderSofiCombinedPdf([
      { account: account("sofi-checking"), period: entry.checking },
      { account: account("sofi-savings"), period: entry.savings },
    ]);
    write(path.join("sofi", "statements", `sofi-combined-${start}.pdf`), bytes);
    pdfCount += 1;
  }

  // ── Corrupted statement (quarantine demo): one Discover month omits a
  //    listed transaction while keeping the printed balances ─────────────
  // month chosen OUTSIDE the Discover CSV's 12-month window, so the PDF is
  // the only source and the reconciliation gap is genuinely detectable
  const corrupted = sim.periods.find(
    (p) => p.accountKey === "discover-card" && monthKey(p.periodStart) === "2024-11" && p.txns.length > 3,
  );
  if (corrupted) {
    fs.mkdirSync(path.join(OUT, "discover", "corrupted"), { recursive: true });
    const bytes = await renderStatementPdf(account("discover-card"), corrupted, { omitTxnIndex: 2 });
    write(path.join("discover", "corrupted", `discover-card-${corrupted.periodStart}_CORRUPTED.pdf`), bytes);
  }

  const lastRobinhoodPeriod = [...sim.periods]
    .filter((p) => p.accountKey === "robinhood-brokerage")
    .sort((a, b) => a.periodEnd.localeCompare(b.periodEnd))
    .at(-1);
  const manifest = {
    generatedFrom: { start: SIM_START, end: SIM_END },
    endBalances: Object.fromEntries(sim.endBalances),
    // an investment account's derived balance carries its LAST statement
    // anchor forward (live prices update it in Phase 7)
    robinhoodLastStatementValueCents: lastRobinhoodPeriod?.endCents ?? null,
    txnCounts: Object.fromEntries([...sim.txns.entries()].map(([k, v]) => [k, v.length])),
    periods: sim.periods.length,
    pdfCount,
    corruptedGapCents: corrupted ? corrupted.txns[2]!.amountCents : null,
  };
  write("manifest.json", JSON.stringify(manifest, null, 2));
  process.stdout.write(
    `fixtures written: ${pdfCount} PDFs, ${chunks.length * 6 + 7} structured files → ${OUT}\n`,
  );
}

void main();
