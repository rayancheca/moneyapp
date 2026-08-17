import fs from "node:fs";
import Database from "better-sqlite3";
import { createDatabase } from "@/db/client";
import { manualSnapshot } from "@/db/backup";
import { extractLines } from "@/services/import/profiles/pdf-profile";
import { parseSweepActivity } from "@/services/import/profiles/robinhood-brokerage-statement-profile";
import { dedupeHash } from "@/lib/hash";

/**
 * The Robinhood crypto trades whose CASH leg was never recorded.
 *
 * Buying crypto at Robinhood moves money out of the same settlement cash the
 * brokerage uses. The crypto account records the asset side; `Robinhood Cash`
 * has to record the cash side or the account spends money it never shows. Pass
 * 42 mirrored 64 such trades — but the earliest mirror it wrote is 2025-11-04,
 * and the crypto account's first trade is 2025-10-16. Every trade in between
 * has an asset leg and no cash leg.
 *
 * That is the whole of the worst month in the archive: 2025-10 is $1,419.78
 * short, and `pnpm rh-sweep-check 2025-10` puts $1,499.99 of it on 2025-10-30
 * alone — the two ETH buys the bank swept out of cash that day.
 *
 * Evidence is ORDERED, and every row says which rung it stands on:
 *
 *   `swept` — a printed sweep row of the same amount (within a cent) and the
 *     opposite sign, on or just after the trade. It supplies both the amount
 *     and the settlement date, and it is preferred because a cash leg is a
 *     claim about cash and the statement is this account's arbiter for cash.
 *     Two of the ten differ from the crypto account by a cent ($499.15 against
 *     $499.16, $1,059.80 against $1,059.79) and the bank's figure is the one
 *     that closes the month.
 *
 *   `traded` — no printed row matches, because the bank BATCHES: 2025-10-23
 *     prints one $620.00 debit covering a $500.00 crypto buy and $120.00 of
 *     recurring equity buys. The trade still moved real cash, so its own amount
 *     and date are used and the row is labelled. Refusing these outright was
 *     the first version of this script and it left the month $600.06 short —
 *     absent confirmation is not evidence of absence when the reason for the
 *     absence is known.
 *
 * A printed row may justify only ONE trade, so two identical buys on one day
 * cannot both point at the same sweep line.
 *
 * ⚠️ Rows are written `status = 'excluded'`, matching the 64 pass 42 already
 * wrote — NOT `active`. `REPLAY_STATUSES` includes `excluded`, so the money
 * still moves the balance, which is the entire point; but these are synthetic
 * mirrors of a trade recorded elsewhere, and as `active` rows they would enter
 * spending analytics as roughly $2,900 of purchases that never happened.
 * `transacted_on` is left null for the same reason the existing rows do: there
 * is one real transaction and it lives on the crypto account.
 *
 * `dedupe_hash` is the app's own `dedupeHash`, not an ad-hoc string, so a
 * future import of the same movement collides with these rather than adding a
 * second copy. `ux_transactions_account_dedupe` is UNIQUE per account, so a
 * collision fails the write instead of duplicating it.
 *
 *   pnpm rh-mirror-crypto-cash             # dry run: prints the evidence
 *   pnpm rh-mirror-crypto-cash --confirm   # writes, behind a restore point
 */

const CASH_ACCOUNT = "019f4c92-3250-7cd2-b24a-ba39058990d2";
const CRYPTO_ACCOUNT = "019f4c7d-cc91-7eb1-a3bb-aee70ab6193e";
const PROFILE = "robinhood-brokerage-statement-pdf";
/** a settlement lands the same day or a couple after; a weekend stretches it */
const SETTLE_WINDOW_DAYS = 4;

const CONFIRMED = process.argv.includes("--confirm");
const money = (c: number): string => `${c < 0 ? "-" : ""}$${(Math.abs(c) / 100).toFixed(2)}`;
const addDays = (day: string, n: number): string =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

const probe = new Database("data/moneyapp.db", { readonly: true });

/** crypto trades with no cash-settlement row anywhere in the cash ledger */
const unmirrored = probe
  .prepare(
    `SELECT c.posted_on AS day, c.amount_cents AS cents, c.raw_description AS descr
       FROM transactions c
      WHERE c.account_id = ?
        AND c.raw_description LIKE 'Crypto %'
        AND NOT EXISTS (
              SELECT 1 FROM transactions m
               WHERE m.account_id = ?
                 AND m.raw_description = 'Cash settlement — ' || c.raw_description)
      ORDER BY c.posted_on, c.amount_cents`,
  )
  .all(CRYPTO_ACCOUNT, CASH_ACCOUNT) as { day: string; cents: number; descr: string }[];

/** every printed sweep movement in the archive, so a date can be justified */
const printed: { day: string; cents: number }[] = [];
for (const f of probe
  .prepare(`SELECT storage_path FROM import_files WHERE parser_profile = ?`)
  .all(PROFILE) as { storage_path: string }[]) {
  if (!fs.existsSync(f.storage_path)) continue;
  const sweep = parseSweepActivity((await extractLines(fs.readFileSync(f.storage_path))).map((l) => l.text));
  if (sweep) printed.push(...sweep.movements.map((m) => ({ day: m.day, cents: m.amountCents })));
}
probe.close();

/**
 * The printed sweep row that settles this trade: the nearest movement on or
 * after the trade date, in the opposite direction, whose amount is within a
 * cent. Each printed row may justify only ONE trade — two identical buys on one
 * day are two rows, and letting one row answer for both would silently halve
 * the correction.
 */
const claimed = new Set<number>();
interface Planned {
  trade: { day: string; cents: number; descr: string };
  evidence: { day: string; cents: number } | null;
}

const planned: Planned[] = unmirrored.map((trade) => {
  let best: number | null = null;
  let bestGap = Infinity;
  printed.forEach((row, i) => {
    if (claimed.has(i)) return;
    // a crypto PURCHASE is positive on the crypto account and must take cash
    // OUT of the sweep, so the signs are opposite
    if (Math.sign(row.cents) === Math.sign(trade.cents)) return;
    if (Math.abs(Math.abs(row.cents) - Math.abs(trade.cents)) > 1) return;
    if (row.day < trade.day || row.day > addDays(trade.day, SETTLE_WINDOW_DAYS)) return;
    const gap = Date.parse(row.day) - Date.parse(trade.day);
    if (gap >= bestGap) return;
    best = i;
    bestGap = gap;
  });
  if (best === null) return { trade, evidence: null };
  claimed.add(best);
  return { trade, evidence: printed[best]! };
});

console.log(`unmirrored crypto trades: ${unmirrored.length}\n`);
console.log(`${"trade day".padEnd(12)} ${"crypto".padStart(12)}  ${"settles".padEnd(12)} ${"bank says".padStart(12)}  description`);
for (const p of planned) {
  console.log(
    `${p.trade.day.padEnd(12)} ${money(p.trade.cents).padStart(12)}  ` +
      `${(p.evidence?.day ?? "NO EVIDENCE").padEnd(12)} ${(p.evidence ? money(p.evidence.cents) : "—").padStart(12)}  ` +
      `${p.trade.descr.slice(0, 44)}`,
  );
}

/** what actually gets written, and on which rung of the evidence ladder */
const rows = planned.map((p) => ({
  descr: `Cash settlement — ${p.trade.descr}`,
  transactedOn: p.trade.day,
  postedOn: p.evidence?.day ?? p.trade.day,
  // a crypto PURCHASE is positive on the crypto account and takes cash OUT
  cents: p.evidence ? p.evidence.cents : -p.trade.cents,
  basis: p.evidence ? ("swept" as const) : ("traded" as const),
  tradeCents: p.trade.cents,
}));

const swept = rows.filter((r) => r.basis === "swept").length;
const net = rows.reduce((n, r) => n + r.cents, 0);

console.log(`\nrows to write   ${rows.length}   (${swept} justified by a printed sweep row, ${rows.length - swept} by the trade itself)`);
console.log(`net cash effect ${money(net)}`);

if (!CONFIRMED) {
  console.log("\nDry run — nothing was written. Re-run with --confirm.");
  process.exit(0);
}

const { db, sqlite } = createDatabase("data/moneyapp.db");
const snap = manualSnapshot(sqlite);
console.log(`\nRestore point: ${snap.path ?? "(none)"}`);

const before = sqlite.prepare(`SELECT COUNT(*) n FROM transactions WHERE account_id = ?`).get(CASH_ACCOUNT) as { n: number };

const insert = sqlite.prepare(
  `INSERT INTO transactions
     (id, account_id, posted_on, transacted_on, amount_cents, raw_description,
      normalized_description, status, needs_review, occurrence_index, dedupe_hash, notes,
      created_at, updated_at)
   VALUES (?, ?, ?, NULL, ?, ?, ?, 'excluded', 0, 0, ?, ?, ?, ?)`,
);

const now = new Date().toISOString();
sqlite.transaction(() => {
  for (const r of rows) {
    insert.run(
      crypto.randomUUID(),
      CASH_ACCOUNT,
      r.postedOn,
      r.cents,
      r.descr,
      r.descr.toLowerCase(),
      dedupeHash({
        accountId: CASH_ACCOUNT,
        postedOn: r.postedOn,
        amountCents: r.cents,
        rawDescription: r.descr,
        occurrenceIndex: 0,
      }),
      r.basis === "swept"
        ? `Cash leg of the Robinhood crypto trade of ${r.transactedOn} (${money(r.tradeCents)}), dated and valued from the printed Deposit Sweep Activity row of ${r.postedOn}.`
        : `Cash leg of the Robinhood crypto trade of ${r.transactedOn} (${money(r.tradeCents)}). The bank batched that day's sweep, so no single printed row matches it — amount and date are the trade's own.`,
      now,
      now,
    );
  }
})();

const after = sqlite.prepare(`SELECT COUNT(*) n FROM transactions WHERE account_id = ?`).get(CASH_ACCOUNT) as { n: number };
console.log(`transactions on Robinhood Cash: ${before.n} → ${after.n}  (+${after.n - before.n})`);
if (after.n - before.n !== rows.length) throw new Error("guard: inserted row count does not match the plan");

const { rebuildAccount } = await import("@/services/derivation");
rebuildAccount(db, CASH_ACCOUNT);
const { reconcileAccounts } = await import("@/services/import/service");
reconcileAccounts(db, [CASH_ACCOUNT]);
console.log("rebuilt and reconciled.");
sqlite.close();
