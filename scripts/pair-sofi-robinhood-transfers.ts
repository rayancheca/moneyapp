import path from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { withPreMutationSnapshot } from "@/db/backup";
import { createDatabase } from "@/db/client";
import { accounts, transactions } from "@/db/schema";
import { compareDates, diffDays } from "@/lib/dates";
import { linkTransferPair } from "@/services/transfer-links";

/**
 * Pairs the SoFi Checking → Robinhood Cash transfer legs sitting in the review
 * queue, using the app's own `linkTransferPair`.
 *
 * The owner's description of the route: "this is just me transfering from sofi
 * saving into robinhood but it goes sofi saving into sofi checking then into
 * robinhood." So the reviewed rows are the SECOND hop — two legs of one move of
 * his own money, which must net to zero rather than read as spend on one side
 * and income on the other.
 *
 * Category is NOT chosen here. `linkTransferPair` calls `transferCategoryResolver`
 * with both account ids, and that resolver deliberately treats the Robinhood
 * settlement-cash sibling as investment-SIDE (`transfer-links.ts:59-80`), so the
 * pair resolves to `Transfers > Investment Contribution` — which is what the SoFi
 * legs already say and what the Robinhood legs (currently `Internal Transfer`)
 * do not. Letting the shipped resolver decide is the point: a hand-picked
 * category here would drift from what the detector stamps on every future import.
 *
 * Matching is by EXACT amount, then nearest date. Robinhood credits before SoFi
 * debits (0–5 days) — the float direction pass 19 measured — so this does not
 * assume the outflow lands first.
 *
 *   pnpm tsx scripts/pair-sofi-robinhood-transfers.ts            # dry run
 *   pnpm tsx scripts/pair-sofi-robinhood-transfers.ts --confirm
 */

const CONFIRMED = process.argv.includes("--confirm");
const DB_PATH =
  process.argv.find((a) => a.startsWith("--db="))?.slice("--db=".length) ??
  path.join("data", "moneyapp.db");

/** widest observed gap between the two legs, +2 days of headroom */
const MAX_LAG_DAYS = 7;

const OUT_DESC = "Debit Card ROBINHOOD SECURITIES";
const IN_DESC = "External debit card transfer";

interface Leg {
  id: string;
  postedOn: string;
  amountCents: number;
}

function main(): void {
  const { db, sqlite } = createDatabase(path.resolve(process.cwd(), DB_PATH));

  const acct = (name: string): string => {
    const row = db.select().from(accounts).where(eq(accounts.name, name)).get();
    if (!row) throw new Error(`No "${name}" account`);
    return row.id;
  };
  const sofi = acct("SoFi Checking");
  const rh = acct("Robinhood Cash");

  const legs = (accountId: string, prefix: string): Leg[] =>
    db
      .select({
        id: transactions.id,
        postedOn: transactions.postedOn,
        amountCents: transactions.amountCents,
        raw: transactions.rawDescription,
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.accountId, accountId),
          eq(transactions.status, "active"),
          eq(transactions.needsReview, true),
          isNull(transactions.transferGroupId),
        ),
      )
      .all()
      .filter((r) => r.raw.startsWith(prefix))
      .map(({ id, postedOn, amountCents }) => ({ id, postedOn, amountCents }))
      .sort((a, b) => compareDates(a.postedOn, b.postedOn));

  const outs = legs(sofi, OUT_DESC).filter((r) => r.amountCents < 0);
  const ins = legs(rh, IN_DESC).filter((r) => r.amountCents > 0);

  console.log(`db=${DB_PATH}`);
  console.log(`SoFi outflow legs : ${outs.length}  (${(outs.reduce((s, r) => s + r.amountCents, 0) / 100).toFixed(2)})`);
  console.log(`RH   inflow legs  : ${ins.length}  (${(ins.reduce((s, r) => s + r.amountCents, 0) / 100).toFixed(2)})`);

  // greedy: exact amount, then nearest date. Deterministic because both sides
  // are date-sorted and each inflow is consumed at most once.
  const taken = new Set<string>();
  const pairs: { out: Leg; in: Leg; lag: number }[] = [];
  for (const o of outs) {
    let best: Leg | null = null;
    let bestLag = Infinity;
    for (const i of ins) {
      if (taken.has(i.id)) continue;
      if (i.amountCents !== -o.amountCents) continue;
      const lag = Math.abs(diffDays(i.postedOn, o.postedOn));
      if (lag > MAX_LAG_DAYS) continue;
      if (lag < bestLag) {
        best = i;
        bestLag = lag;
      }
    }
    if (best) {
      taken.add(best.id);
      pairs.push({ out: o, in: best, lag: bestLag });
    }
  }

  const orphanOuts = outs.filter((o) => !pairs.some((p) => p.out.id === o.id));
  const orphanIns = ins.filter((i) => !taken.has(i.id));

  console.log(`\nmatched pairs: ${pairs.length}`);
  for (const p of pairs) {
    console.log(
      `  ${p.in.postedOn} RH +${(p.in.amountCents / 100).toFixed(2).padStart(8)}  <->  ${p.out.postedOn} SoFi ${(p.out.amountCents / 100).toFixed(2).padStart(9)}   lag ${p.lag}d`,
    );
  }
  if (orphanOuts.length > 0) {
    console.log(`\nUNMATCHED SoFi outflows (left alone, still in review):`);
    for (const o of orphanOuts) console.log(`  ${o.postedOn}  ${(o.amountCents / 100).toFixed(2)}`);
  }
  if (orphanIns.length > 0) {
    console.log(`\nUNMATCHED RH inflows (left alone, still in review):`);
    for (const i of orphanIns) console.log(`  ${i.postedOn}  +${(i.amountCents / 100).toFixed(2)}`);
  }

  if (!CONFIRMED) {
    console.log("\nDRY RUN — nothing written. Re-run with --confirm.");
    sqlite.close();
    return;
  }

  withPreMutationSnapshot(db, "pair-sofi-robinhood-transfers", () => {
    for (const p of pairs) linkTransferPair(db, p.out.id, p.in.id);
  });
  console.log(`\nlinked ${pairs.length} pairs (${pairs.length * 2} rows)`);

  sqlite.close();
}

main();
