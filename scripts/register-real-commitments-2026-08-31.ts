/**
 * REAL-DB WRITE (dry run by default). The owner's actual monthly commitments,
 * given with screenshots on 2026-08-31.
 *
 * Everything here is a figure HE stated or a bill he photographed — none of it
 * is detection's guess, so every amount is written to `user_amount_cents` and
 * every end date to `user_ends_on`. Detection keeps its own columns; the UI and
 * the forecast read user-first.
 *
 * ## What the screenshots said, and what the ledger said
 *
 * | | ledger before | the bill | |
 * |---|---|---|---|
 * | Car lease | $559.89 on the 11th | **$695.04**, next **09/15/2026** | Mercedes-Benz Finance |
 * | Car insurance | $361.49 on the 11th → 2027-01-11 | $361.49 × 4 then $361.46 | Progressive |
 * | Rent | $2,285.70 | **$2,109.00 base** + $182.21 fees = $2,291.21 | resident portal |
 * | FPL | $14.21 on the 10th | **$58.87**, due **Sep 8** | FPL |
 * | Internet | $50.00 on the 10th | $50.00, autopay **Sep 8** | provider app |
 * | Parking | — | **$368.86** per quarter, first 2026-07-20 | stated |
 * | Gym | — | **$100.00** on the 22nd | stated |
 *
 * ⛔ **The lease is $135.15 a month more than the ledger believed**, over 24
 * payments — **$3,243.60** of committed money the runway could not see. The
 * $559.89 came from `register-car-commitments.ts` on 2026-08-11, whose own
 * header records that two sessions had been told different numbers. The
 * screenshot is the arbiter now.
 *
 * ⚠️ **The lease day is the 15th, not the 11th**, on the owner's instruction
 * after being shown that his message said the 11th and the app said 09/15/2026.
 * The contract's End Date (08/11/2028) is an 11th, which is why it was worth
 * asking rather than assuming.
 *
 * ## ⛔ Rent is split, and the split has a consequence
 *
 * At the owner's choice: `Flamingo South Beach (rent)` becomes the BASE
 * $2,109.00, and a second series carries the $182.21 of landlord-billed sewer,
 * gas, electric, pest control and energy-conservation fees.
 *
 * ⚠️ He pays ONE charge of $2,291.21, so the calendar will show two expected
 * lines against one posting. That is the cost of separating the fixed part from
 * the variable one, and it is his call, not a defect.
 *
 * ⚠️ The fees land in `Housing > Rent`, NOT in Utilities: they arrive on the
 * rent statement and leave in the rent payment, and filing them under Utilities
 * would count them against a budget that already holds FPL and the internet.
 *
 * ⚠️ Only **$111.70** of the $182.21 is itemised in the screenshot (sewer
 * $55.90, electric $39.71, gas $6.92, energy conservation $6.95, pest control
 * $2.22). The remaining **$70.51** is on line items above the visible cut. The
 * $182.21 is measured — total minus base — not assembled from the parts.
 *
 * ## Budgets
 *
 * A budget is a DECISION, not a derived number, so each one moves by exactly
 * the change in its category's commitments — whatever discretionary headroom
 * was in it stays in it. The arithmetic is printed for every line.
 *
 *   npx tsx scripts/register-real-commitments-2026-08-31.ts            # DRY RUN
 *   npx tsx scripts/register-real-commitments-2026-08-31.ts --confirm  # writes
 *
 * ⚠️ `--confirm` needs the dev server stopped.
 */
import { eq, isNull, and } from "drizzle-orm";
import { withPreMutationSnapshot } from "@/db/backup";
import { getDb, type AppDatabase } from "@/db/client";
import { budgets, categories, recurringSeries } from "@/db/schema";
import type { Cadence, SeriesKind } from "@/db/schema/recurring";
import { formatCents } from "@/lib/money";
import { recurringSeriesIdsForCategory } from "@/services/analytics";

const CONFIRMED = process.argv.includes("--confirm");

/** An existing series to correct, found BY NAME (they are all unique here). */
interface Correction {
  readonly name: string;
  readonly amountCents?: number;
  readonly nextExpectedOn?: string;
  readonly endsOn?: string | null;
  readonly anchorDay?: number;
  readonly why: string;
}

/** A commitment the ledger has never had. */
interface Addition {
  readonly name: string;
  readonly kind: SeriesKind;
  readonly cadence: Cadence;
  readonly categoryPath: string;
  readonly amountCents: number;
  readonly nextExpectedOn: string;
  readonly anchorDay: number;
  readonly endsOn: string | null;
  readonly why: string;
}

const CORRECTIONS: readonly Correction[] = [
  {
    name: "Car lease",
    amountCents: -69_504,
    nextExpectedOn: "2026-09-15",
    endsOn: "2028-08-15",
    anchorDay: 15,
    why: "Mercedes-Benz Finance: $695.04, next 09/15/2026, 24 payments (was $559.89 on the 11th)",
  },
  {
    name: "Flamingo South Beach (rent)",
    amountCents: -210_900,
    nextExpectedOn: "2026-09-01",
    anchorDay: 1,
    why: "the BASE rent; the landlord's fees move to their own line (was $2,285.70, a past total)",
  },
  {
    name: "FPL (electricity)",
    amountCents: -5_887,
    nextExpectedOn: "2026-09-08",
    anchorDay: 8,
    why: "FPL bill: $58.87 due Sep 8 (was $14.21 on the 10th)",
  },
  {
    name: "Breezeline (internet)",
    amountCents: -5_000,
    nextExpectedOn: "2026-09-08",
    anchorDay: 8,
    why: "autopay $50.00 on the 8th — amount unchanged, day was the 10th",
  },
];

const ADDITIONS: readonly Addition[] = [
  {
    name: "Rent utilities & fees",
    kind: "bill",
    cadence: "monthly",
    categoryPath: "Housing > Rent",
    amountCents: -18_221,
    nextExpectedOn: "2026-09-01",
    anchorDay: 1,
    endsOn: null,
    why: "$2,291.21 charged − $2,109.00 base; sewer, gas, electric, pest control, energy conservation",
  },
  {
    name: "Parking",
    kind: "bill",
    cadence: "quarterly",
    categoryPath: "Transport > Parking & Tolls",
    amountCents: -36_886,
    // first payment was 2026-07-20; the next quarter falls on 2026-10-20
    nextExpectedOn: "2026-10-20",
    anchorDay: 20,
    endsOn: null,
    why: "$368.86 covering three months, first paid 2026-07-20, renewed each quarter",
  },
  {
    name: "Gym",
    kind: "subscription",
    cadence: "monthly",
    categoryPath: "Health > Fitness",
    amountCents: -10_000,
    nextExpectedOn: "2026-09-22",
    anchorDay: 22,
    endsOn: null,
    why: "$100.00 on the 22nd",
  },
];

/**
 * A quarterly charge has no honest monthly figure, and this is the one the
 * budget has to use anyway. Named so the output can say so out loud.
 */
const MONTHS_PER_QUARTER = 3;

const failures: string[] = [];
const guard = (name: string, ok: boolean, detail: string): void => {
  console.log(`${ok ? "  ✓" : "  ✗"} ${name.padEnd(44)} ${detail}`);
  if (!ok) failures.push(name);
};

function categoryIdFor(db: AppDatabase, path: string): string {
  const [parentName, childName] = path.split(" > ").map((s) => s.trim());
  const parent = db
    .select({ id: categories.id })
    .from(categories)
    .where(and(eq(categories.name, parentName!), isNull(categories.parentId)))
    .get();
  if (!parent) throw new Error(`no top-level category "${parentName}"`);
  if (!childName) return parent.id;
  const child = db
    .select({ id: categories.id })
    .from(categories)
    .where(and(eq(categories.name, childName), eq(categories.parentId, parent.id)))
    .get();
  if (!child) throw new Error(`no category "${path}"`);
  return child.id;
}

function seriesByName(db: AppDatabase, name: string) {
  return db.select().from(recurringSeries).where(eq(recurringSeries.name, name)).get();
}

/**
 * Every live series' monthly-equivalent cost, per budgeted top-level category.
 *
 * ⛔ Uses the app's OWN membership function. The first version of this walked
 * `user_category_id` directly and was wrong in both directions: it saw the three
 * new series (which carry an override) and was blind to rent, FPL and the
 * internet (which derive their category from POSTED rows). It reported Housing
 * needing +$182.21 when the true change is +$5.51, because it added the new fees
 * line without seeing the rent it was split out of.
 *
 * `recurringSeriesIdsForCategory` already answers "which series belong to this
 * category", override rule included. A second opinion about that was exactly
 * the kind of drift this repo keeps paying for.
 */
const PER_MONTH: Record<string, number> = {
  weekly: 52 / 12,
  biweekly: 26 / 12,
  semimonthly: 2,
  monthly: 1,
  quarterly: 1 / MONTHS_PER_QUARTER,
  annual: 1 / 12,
};

function monthlyCommitmentByBudget(db: AppDatabase): Map<string, number> {
  const rows = db.select().from(recurringSeries).all();
  const byId = new Map(rows.map((s) => [s.id, s]));
  const out = new Map<string, number>();
  for (const b of db.select().from(budgets).where(eq(budgets.isActive, true)).all()) {
    let total = 0;
    for (const id of recurringSeriesIdsForCategory(db, b.categoryId)) {
      const s = byId.get(id);
      if (!s) continue;
      if (s.status !== "confirmed" && s.status !== "detected") continue;
      const cents = s.userAmountCents ?? s.nextExpectedAmountCents ?? s.amountCentsAvg ?? 0;
      if (cents >= 0) continue;
      total += Math.abs(cents) * (PER_MONTH[s.userCadence ?? s.cadence] ?? 1);
    }
    out.set(b.id, total);
  }
  return out;
}

function run(db: AppDatabase): void {
  console.log(`\n── corrections to series the ledger already has ──`);
  const corrections = CORRECTIONS.map((c) => {
    const existing = seriesByName(db, c.name);
    if (!existing) throw new Error(`no series named "${c.name}" — refusing to guess`);
    return { ...c, id: existing.id, existing };
  });
  for (const c of corrections) {
    const wasAmt = c.existing.userAmountCents ?? c.existing.nextExpectedAmountCents ?? 0;
    const wasNext = c.existing.userNextExpectedOn ?? c.existing.nextExpectedOn ?? "—";
    console.log(
      `  ${c.name.padEnd(30)} ${formatCents(wasAmt).padStart(11)} → ${formatCents(c.amountCents ?? wasAmt).padStart(11)}` +
        `   ${wasNext} → ${c.nextExpectedOn ?? wasNext}` +
        `${c.endsOn ? `   ends ${c.existing.userEndsOn ?? "—"} → ${c.endsOn}` : ""}`,
    );
    console.log(`      ${c.why}`);
  }

  console.log(`\n── commitments the ledger has never had ──`);
  const additions = ADDITIONS.map((a) => ({ ...a, existing: seriesByName(db, a.name) }));
  for (const a of additions) {
    console.log(
      `  ${a.existing ? "EXISTS (skip)" : "create       "} ${a.name.padEnd(24)} ` +
        `${formatCents(a.amountCents).padStart(11)} ${a.cadence.padEnd(9)} next ${a.nextExpectedOn} → ${a.categoryPath}`,
    );
    console.log(`      ${a.why}`);
  }

  const beforeByBudget = monthlyCommitmentByBudget(db);

  if (!CONFIRMED) {
    console.log(`\n── budgets, once the above is in ──`);
  }

  const write = (): void => {
    for (const c of corrections) {
      db.update(recurringSeries)
        .set({
          ...(c.amountCents !== undefined && {
            userAmountCents: c.amountCents,
            nextExpectedAmountCents: c.amountCents,
          }),
          ...(c.nextExpectedOn !== undefined && {
            userNextExpectedOn: c.nextExpectedOn,
            nextExpectedOn: c.nextExpectedOn,
          }),
          ...(c.endsOn !== undefined && { userEndsOn: c.endsOn }),
          ...(c.anchorDay !== undefined && { anchorDay: c.anchorDay }),
          status: "confirmed",
        })
        .where(eq(recurringSeries.id, c.id))
        .run();
    }
    for (const a of additions) {
      if (a.existing) continue;
      db.insert(recurringSeries)
        .values({
          name: a.name,
          kind: a.kind,
          cadence: a.cadence,
          intervalDaysAvg: a.cadence === "quarterly" ? 91 : 30,
          amountCentsAvg: a.amountCents,
          nextExpectedOn: a.nextExpectedOn,
          nextExpectedAmountCents: a.amountCents,
          anchorDay: a.anchorDay,
          status: "confirmed",
          // the owner STATED these; they are not detection's guess
          userAmountCents: a.amountCents,
          userCategoryId: categoryIdFor(db, a.categoryPath),
          userEndsOn: a.endsOn,
        })
        .run();
    }
  };

  if (CONFIRMED) {
    write();
  } else {
    // rehearse the budget arithmetic against the post-write state, inside a
    // transaction that is rolled back — a dry run that guessed at the numbers
    // would be describing a plan rather than previewing one
    try {
      db.transaction((tx) => {
        write();
        reportBudgets(db, beforeByBudget);
        throw new RollbackDryRun();
      });
    } catch (e) {
      if (!(e instanceof RollbackDryRun)) throw e;
    }
    console.log(`\n  (dry run — nothing written. Re-run with --confirm.)`);
    return;
  }

  console.log(`\n── budgets ──`);
  reportBudgets(db, beforeByBudget);

  console.log(`\n  guards`);
  for (const c of corrections) {
    const now = seriesByName(db, c.name)!;
    guard(
      `${c.name} corrected`,
      (c.amountCents === undefined || now.userAmountCents === c.amountCents) &&
        (c.nextExpectedOn === undefined || now.userNextExpectedOn === c.nextExpectedOn),
      `${formatCents(now.userAmountCents ?? 0)} next ${now.userNextExpectedOn ?? "—"}`,
    );
  }
  for (const a of ADDITIONS) {
    const now = seriesByName(db, a.name);
    guard(`${a.name} exists`, now !== undefined && now.userAmountCents === a.amountCents, now ? formatCents(now.userAmountCents ?? 0) : "missing");
  }
  guard(
    "Car insurance untouched",
    seriesByName(db, "Car insurance")?.userAmountCents === -36_149,
    "the Progressive schedule already matched the ledger",
  );
}

class RollbackDryRun extends Error {}

/** Move each budget by exactly the change in its category's commitments. */
function reportBudgets(db: AppDatabase, before: Map<string, number>): void {
  const after = monthlyCommitmentByBudget(db);
  const cats = db.select().from(categories).all();
  const byId = new Map(cats.map((c) => [c.id, c]));

  for (const b of db.select().from(budgets).where(eq(budgets.isActive, true)).all()) {
    const cat = byId.get(b.categoryId);
    if (!cat) continue;
    const was = before.get(b.id) ?? 0;
    const now = after.get(b.id) ?? 0;
    const delta = Math.round(now - was);
    if (delta === 0) continue;
    const next = b.amountCents + delta;
    console.log(
      `  ${cat.name.padEnd(14)} ${formatCents(b.amountCents).padStart(11)} → ${formatCents(next).padStart(11)}` +
        `   (commitments ${formatCents(Math.round(was))} → ${formatCents(Math.round(now))}, ${delta > 0 ? "+" : ""}${formatCents(delta)})`,
    );
    if (CONFIRMED) {
      db.update(budgets).set({ amountCents: next }).where(eq(budgets.id, b.id)).run();
    }
  }
  console.log(
    `  ⚠️  Transport carries a QUARTERLY charge; ${formatCents(36_886)} every three months is ` +
      `${formatCents(Math.round(36_886 / MONTHS_PER_QUARTER))} a month, so the month it actually charges will run over.`,
  );
}

const db = getDb();
if (CONFIRMED) {
  withPreMutationSnapshot(db, "register-real-commitments-2026-08-31", () => run(db));
} else {
  run(db);
}

if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} guard(s) failed: ${failures.join(", ")}`);
  process.exit(1);
}
if (CONFIRMED) console.log(`\n✓ all guards passed`);
