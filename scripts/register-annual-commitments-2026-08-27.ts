import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { withPreMutationSnapshot } from "@/db/backup";
import { createDatabase } from "@/db/client";
import { categories, recurringSeries, transactions } from "@/db/schema";
import { formatCents } from "@/lib/money";

/**
 * REAL-DB WRITE. Registers the three charges the owner pays ONCE A YEAR, and
 * files the Venture X fee where it belongs.
 *
 * Owner, 2026-08-27: *"i paid for a one year hbo max subsription for around 200
 * bucks idk why yo udidnt show that. the venture x charges 325 or 395 a year i
 * dont remember. sapphire charges 95 a year. these are just the fees to own the
 * card. paid once a year. so do the manth. the ynever charge interest cause i
 * never hold a balance"*
 *
 * ## ⛔ Why the app never showed them
 *
 * Not a detection bug. `MIN_OCCURRENCES = 3` — the detector will not call
 * anything recurring until it has seen it three times, which for a yearly
 * charge means **three years of statements**:
 *
 *   HBO Max            1 charge   (Venture X opened 2026-01)
 *   Venture X fee      1 charge   (same)
 *   Sapphire fee       2 charges  (2025-03-02 and 2026-03-01 — one short)
 *
 * The rule is right and the cadence is right; they simply cannot meet yet. So
 * these are registered by hand, exactly as the car lease and its insurance were
 * — an owner-stated commitment rather than a detector guess, which is what
 * `user_amount_cents` and `user_category_id` exist for.
 *
 * ## ⚠️ Two of his three figures are corrected by his own documents
 *
 *   HBO Max      he said "around 200"      the charge is $260.26 (2026-07-18)
 *   Venture X    he said "325 or 395"      the charge is $395.00 (2026-01-16)
 *   Sapphire     he said 95                the charge is  $95.00 ✓ (twice)
 *
 * The ledger's figures are used, because a document beats a recollection. He is
 * told the difference rather than it being silently absorbed.
 *
 * ## ⚠️ And his last sentence checks out
 *
 * "they never charge interest cause i never hold a balance" — `Interest
 * Charges` holds **0 rows** across the whole ledger. The category is empty
 * because the thing never happened, not because it was never imported.
 *
 * ## The misfile
 *
 * `CAPITAL ONE MEMBER FEE  −$395.00` sits in `Bank Fees`, so the largest card
 * fee he pays is counted as something a bank charged him rather than as the
 * price of owning the card. It moves to `Card Annual Fees` beside the two
 * Sapphire ones. Both are children of `Fees`, so no total moves — only the
 * bucket, and the bucket is what the fees card reads.
 *
 *   pnpm tsx scripts/register-annual-commitments-2026-08-27.ts            # dry run
 *   pnpm tsx scripts/register-annual-commitments-2026-08-27.ts --confirm
 */

const CONFIRMED = process.argv.includes("--confirm");
const DB_PATH =
  process.argv.find((a) => a.startsWith("--db="))?.slice("--db=".length) ?? path.join("data", "moneyapp.db");

interface AnnualCommitment {
  readonly name: string;
  readonly kind: "bill" | "subscription";
  readonly categoryName: string;
  /** negative — money out */
  readonly amountCents: number;
  /** the charge already in the ledger, matched exactly */
  readonly seenOn: string;
  readonly descriptionLike: string;
  readonly nextExpectedOn: string;
  readonly note: string;
}

const COMMITMENTS: readonly AnnualCommitment[] = [
  {
    name: "Venture X annual fee",
    kind: "bill",
    categoryName: "Card Annual Fees",
    amountCents: -39_500,
    seenOn: "2026-01-16",
    descriptionLike: "CAPITAL ONE MEMBER FEE",
    nextExpectedOn: "2027-01-16",
    note: "$395.00, not $325 — the charge says so",
  },
  {
    name: "Chase Sapphire annual fee",
    kind: "bill",
    categoryName: "Card Annual Fees",
    amountCents: -9_500,
    seenOn: "2026-03-01",
    descriptionLike: "ANNUAL MEMBERSHIP FEE",
    nextExpectedOn: "2027-03-01",
    note: "charged 2025-03-02 and 2026-03-01; two is one short of detection",
  },
  {
    name: "HBO Max",
    kind: "subscription",
    categoryName: "Streaming",
    amountCents: -26_026,
    seenOn: "2026-07-18",
    descriptionLike: "help.hbomax.com",
    nextExpectedOn: "2027-07-18",
    /*
     * ⚠️ No end date. He called it "a one year subscription", and an annual
     * subscription that does not auto-renew should be `ended` rather than
     * forecast into 2027. That is his call, not a guess this script gets to
     * make: it is registered as renewing, and marking it ended on /recurring is
     * one click if it does not.
     */
    note: "$260.26, not ~$200 — mark it ended on /recurring if it does not renew",
  },
];

function main(): void {
  const { db, sqlite } = createDatabase(path.resolve(process.cwd(), DB_PATH));

  const categoryId = (name: string): string => {
    const row = db.select().from(categories).where(eq(categories.name, name)).get();
    if (!row) throw new Error(`No "${name}" category`);
    return row.id;
  };

  const planned = COMMITMENTS.map((c) => {
    const charge = db
      .select()
      .from(transactions)
      .where(and(eq(transactions.postedOn, c.seenOn), eq(transactions.amountCents, c.amountCents)))
      .all()
      .find((t) => t.rawDescription.includes(c.descriptionLike));
    if (!charge) {
      throw new Error(`No ${formatCents(c.amountCents)} "${c.descriptionLike}" charge on ${c.seenOn}`);
    }
    const existing = db.select().from(recurringSeries).where(eq(recurringSeries.name, c.name)).get();
    return { ...c, charge, categoryId: categoryId(c.categoryName), existingId: existing?.id ?? null };
  });

  // the misfile: the Venture X fee is in Bank Fees, not Card Annual Fees
  const bankFees = categoryId("Bank Fees");
  const cardFees = categoryId("Card Annual Fees");
  const misfiled = planned.filter((p) => p.charge.categoryId === bankFees && p.categoryId === cardFees);

  console.log(`db=${DB_PATH}\n`);
  for (const p of planned) {
    console.log(
      `  ${p.existingId ? "EXISTS (skip)" : "create"}  ${p.name.padEnd(26)} ` +
        `${formatCents(p.amountCents).padStart(10)}/yr  = ${formatCents(Math.round(p.amountCents / 12)).padStart(9)}/mo  ` +
        `next ${p.nextExpectedOn}  -> ${p.categoryName}`,
    );
    console.log(`      ${p.note}`);
  }
  for (const p of misfiled) console.log(`\n  recategorize  ${p.charge.rawDescription}  Bank Fees -> Card Annual Fees`);

  const toCreate = planned.filter((p) => p.existingId === null);
  const monthly = planned.reduce((sum, p) => sum + Math.round(p.amountCents / 12), 0);
  console.log(`\n  all three together: ${formatCents(monthly)} a month, ${formatCents(planned.reduce((s, p) => s + p.amountCents, 0))} a year`);

  if (!CONFIRMED) {
    console.log("\nDRY RUN — nothing written. Re-run with --confirm.");
    sqlite.close();
    return;
  }

  withPreMutationSnapshot(db, "register-annual-commitments", () => {
    for (const p of misfiled) {
      db.update(transactions)
        .set({ categoryId: cardFees, categorizationSource: "user", updatedAt: new Date().toISOString() })
        .where(eq(transactions.id, p.charge.id))
        .run();
      console.log(`recategorized ${p.charge.rawDescription} -> Card Annual Fees`);
    }
    for (const p of toCreate) {
      const row = db
        .insert(recurringSeries)
        .values({
          name: p.name,
          kind: p.kind,
          cadence: "annual",
          intervalDaysAvg: 365,
          amountCentsAvg: p.amountCents,
          nextExpectedOn: p.nextExpectedOn,
          nextExpectedAmountCents: p.amountCents,
          // the owner stated these, and his own documents settled the figures —
          // they are not detection's guess, and detection could not have made
          // one from a single charge
          userAmountCents: p.amountCents,
          userCategoryId: p.categoryId,
          accountId: p.charge.accountId,
          status: "confirmed",
          lastMatchedOn: p.seenOn,
          anchorDay: Number(p.seenOn.slice(8, 10)),
          toleranceDays: 14,
        })
        .returning({ id: recurringSeries.id })
        .get();
      /*
       * Link the charge that proves it. Without this the series has a cadence
       * and no history, and `/recurring` would show a confirmed annual bill
       * with nothing behind it — which is the shape a reader cannot check.
       */
      db.update(transactions)
        .set({ recurringSeriesId: row.id, seriesLinkSource: "user", updatedAt: new Date().toISOString() })
        .where(eq(transactions.id, p.charge.id))
        .run();
      console.log(`created "${p.name}" (${row.id}) and linked its ${p.seenOn} charge`);
    }

    /*
     * The Sapphire fee has a SECOND charge a year earlier. Linking it too is
     * what turns "confirmed, one sighting" into a series with a real interval —
     * and it is the row that proves the cadence is a year rather than an
     * assertion that it is.
     */
    const sapphire = db.select().from(recurringSeries).where(eq(recurringSeries.name, "Chase Sapphire annual fee")).get();
    if (sapphire) {
      const earlier = db
        .select()
        .from(transactions)
        .where(and(eq(transactions.postedOn, "2025-03-02"), eq(transactions.amountCents, -9_500)))
        .all()
        .filter((t) => t.rawDescription.includes("ANNUAL MEMBERSHIP FEE"));
      for (const t of earlier) {
        db.update(transactions)
          .set({ recurringSeriesId: sapphire.id, seriesLinkSource: "user", updatedAt: new Date().toISOString() })
          .where(eq(transactions.id, t.id))
          .run();
        console.log(`linked the 2025-03-02 Sapphire fee to the same series`);
      }
    }
  });

  // ── guards ─────────────────────────────────────────────────────────────
  const failures: string[] = [];
  const guard = (name: string, ok: boolean, detail: string): void => {
    console.log(`${ok ? "  ✓" : "  ✗"} ${name.padEnd(34)} ${detail}`);
    if (!ok) failures.push(name);
  };

  const seriesNow = db.select().from(recurringSeries).all();
  for (const c of COMMITMENTS) {
    const s = seriesNow.find((r) => r.name === c.name);
    guard(c.name, s !== undefined && s.cadence === "annual" && s.userAmountCents === c.amountCents,
      s ? `${s.cadence} ${formatCents(s.userAmountCents ?? 0)} next ${s.nextExpectedOn}` : "MISSING");
  }
  const linked = db.select().from(transactions).where(inArray(transactions.recurringSeriesId, seriesNow.filter((s) => COMMITMENTS.some((c) => c.name === s.name)).map((s) => s.id))).all();
  guard("charges linked to their series", linked.length === 4, `${linked.length} rows (3 commitments + the older Sapphire fee)`);
  const stillMisfiled = db
    .select()
    .from(transactions)
    .where(eq(transactions.categoryId, bankFees))
    .all()
    .filter((t) => t.rawDescription.includes("CAPITAL ONE MEMBER FEE"));
  guard("Venture X fee left Bank Fees", stillMisfiled.length === 0, "it is a card fee, not a bank charge");

  sqlite.close();
  if (failures.length > 0) throw new Error(`GUARD FAILED: ${failures.join(", ")}`);
  console.log("\nall guards held.");
}

main();
