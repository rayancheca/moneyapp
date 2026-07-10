import { and, eq, isNull } from "drizzle-orm";
import { resolveCategoryIdentity } from "@/lib/category-identity";
import type { AppDatabase } from "./client";
import { categories, type CategoryKind } from "./schema/categories";
import { institutions } from "./schema/institutions";
import { merchantAliases, merchants } from "./schema/merchants";
import { rules, type RuleActions, type RuleConditions } from "./schema/rules";
import { appSettings } from "./schema/settings";
import { SEED_MERCHANTS } from "./seed-merchants";

type SeedExecutor = Parameters<Parameters<AppDatabase["transaction"]>[0]>[0];

export const INSTITUTION_NAMES = [
  "Chase",
  "Discover",
  "Capital One",
  "SoFi",
  "Robinhood",
] as const;

interface TaxonomyEntry {
  name: string;
  kind: CategoryKind;
  subs: string[];
}

/** The approved taxonomy (master-plan §2). User-editable after seeding. */
export const TAXONOMY: TaxonomyEntry[] = [
  { name: "Income", kind: "income", subs: ["Salary", "Interest", "Dividends", "Refunds & Reimbursements", "Other Income"] },
  { name: "Housing", kind: "expense", subs: ["Rent", "Home Supplies", "Furniture"] },
  { name: "Utilities", kind: "expense", subs: ["Electricity", "Water/Gas", "Internet", "Mobile"] },
  { name: "Food", kind: "expense", subs: ["Groceries", "Dining", "Coffee", "Delivery"] },
  { name: "Transport", kind: "expense", subs: ["Gas", "Rideshare", "Public Transit", "Parking & Tolls", "Auto Maintenance"] },
  { name: "Travel", kind: "expense", subs: ["Flights", "Hotels", "Other Travel"] },
  { name: "Shopping", kind: "expense", subs: ["Clothing", "Electronics", "General"] },
  { name: "Subscriptions", kind: "expense", subs: ["Streaming", "Software", "Memberships"] },
  { name: "Health", kind: "expense", subs: ["Medical", "Pharmacy", "Fitness"] },
  { name: "Entertainment", kind: "expense", subs: ["Events", "Hobbies", "Games"] },
  { name: "Personal Care", kind: "expense", subs: [] },
  { name: "Education", kind: "expense", subs: [] },
  { name: "Gifts & Donations", kind: "expense", subs: [] },
  { name: "Cash & ATM", kind: "expense", subs: ["ATM Withdrawals"] },
  { name: "Fees", kind: "expense", subs: ["Bank Fees", "Card Annual Fees", "Interest Charges", "ATM Fees"] },
  { name: "Rewards", kind: "rewards", subs: ["Cash Back", "Statement Credits"] },
  { name: "Transfers", kind: "transfer", subs: ["Credit Card Payment", "Internal Transfer", "Investment Contribution"] },
  { name: "Investments", kind: "investment", subs: ["Buys", "Sells"] },
  { name: "Uncategorized", kind: "system", subs: [] },
];

export const DEFAULT_SETTINGS: Record<string, unknown> = {
  aiMonthlyCapUsd: 5,
  priceStalenessHours: 4,
  reviewCreditThresholdCents: 20_000,
  categorizationConfidenceMin: 0.8,
  weekStartsOn: "monday",
  backupRetention: { keepDaily: 14, keepMonthly: 6 },
};

export interface SeedSummary {
  institutions: number;
  categories: number;
  merchants: number;
  rules: number;
  settings: number;
}

/**
 * Idempotent and transactional (BEGIN IMMEDIATE) — concurrent seeders (boot
 * hook + CLI) serialize instead of racing check-then-insert paths, and the
 * root-name/rule-name unique indexes back the checks at the DB level.
 */
export function seedDatabase(db: AppDatabase): SeedSummary {
  return db.transaction((tx) => seedWithin(tx), { behavior: "immediate" });
}

function seedWithin(tx: SeedExecutor): SeedSummary {
  const summary: SeedSummary = { institutions: 0, categories: 0, merchants: 0, rules: 0, settings: 0 };

  for (const name of INSTITUTION_NAMES) {
    summary.institutions += tx.insert(institutions).values({ name }).onConflictDoNothing().run().changes;
  }

  for (const [i, entry] of TAXONOMY.entries()) {
    let parent = tx
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.name, entry.name), isNull(categories.parentId)))
      .get();
    if (!parent) {
      parent = tx
        .insert(categories)
        .values({ name: entry.name, kind: entry.kind, isSystem: true, sortOrder: i * 10 })
        .returning({ id: categories.id })
        .get();
      summary.categories += 1;
    }
    for (const [j, sub] of entry.subs.entries()) {
      summary.categories += tx
        .insert(categories)
        .values({ name: sub, parentId: parent.id, kind: entry.kind, isSystem: true, sortOrder: j * 10 })
        .onConflictDoNothing()
        .run().changes;
    }
  }

  // Category identity backfill (UX overhaul Stage 0): assign icon + hue to
  // system rows that still lack them. Idempotent; user edits are never
  // overwritten (only-null guard); custom categories pick identity in the UI.
  const identityRows = tx
    .select({
      id: categories.id,
      name: categories.name,
      parentId: categories.parentId,
      icon: categories.icon,
      color: categories.color,
    })
    .from(categories)
    .where(eq(categories.isSystem, true))
    .all();
  const rootNameById = new Map(
    identityRows.filter((c) => c.parentId === null).map((c) => [c.id, c.name]),
  );
  for (const cat of identityRows) {
    if (cat.icon !== null && cat.color !== null) continue;
    const identity =
      cat.parentId === null
        ? resolveCategoryIdentity(cat.name)
        : resolveCategoryIdentity(cat.name, rootNameById.get(cat.parentId));
    tx.update(categories)
      .set({ icon: cat.icon ?? identity.icon, color: cat.color ?? identity.hue })
      .where(eq(categories.id, cat.id))
      .run();
  }

  const salary = tx
    .select({ id: categories.id })
    .from(categories)
    .where(eq(categories.name, "Salary"))
    .get();
  const cardPayment = tx
    .select({ id: categories.id })
    .from(categories)
    .where(eq(categories.name, "Credit Card Payment"))
    .get();
  if (!salary || !cardPayment) throw new Error("Seed failure: taxonomy rows missing");

  // Synthetic merchant so the weekly cash salary is visible to
  // merchant-grouped recurring detection (review finding, master-plan §2).
  summary.merchants += tx
    .insert(merchants)
    .values({ canonicalName: "Employer (cash)", defaultCategoryId: salary.id, mappingSource: "seed" })
    .onConflictDoNothing()
    .run().changes;

  // Starter merchant→category map (mapping_source='seed') — the base the
  // learning layer grows from; user mappings always override.
  const categoryIdByPath = (path: string): string => {
    const [parentName, subName] = path.split(" > ");
    const parent = tx
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.name, parentName!), isNull(categories.parentId)))
      .get();
    if (!parent) throw new Error(`Seed failure: missing category ${parentName}`);
    if (!subName) return parent.id;
    const sub = tx
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.name, subName), eq(categories.parentId, parent.id)))
      .get();
    if (!sub) throw new Error(`Seed failure: missing category ${path}`);
    return sub.id;
  };

  for (const sm of SEED_MERCHANTS) {
    const inserted = tx
      .insert(merchants)
      .values({
        canonicalName: sm.name,
        defaultCategoryId: categoryIdByPath(sm.category),
        mappingSource: "seed",
      })
      .onConflictDoNothing()
      .run().changes;
    summary.merchants += inserted;
    const merchantRow = tx
      .select({ id: merchants.id })
      .from(merchants)
      .where(eq(merchants.canonicalName, sm.name))
      .get();
    if (!merchantRow) throw new Error(`Seed failure: merchant ${sm.name} missing`);
    for (const pattern of sm.aliases) {
      tx.insert(merchantAliases)
        .values({ merchantId: merchantRow.id, pattern, matchType: "contains" })
        .onConflictDoNothing()
        .run();
    }
  }

  const employer = tx
    .select({ id: merchants.id })
    .from(merchants)
    .where(eq(merchants.canonicalName, "Employer (cash)"))
    .get();
  if (!employer) throw new Error("Seed failure: Employer (cash) merchant missing");

  const seedRules: { name: string; priority: number; conditions: RuleConditions; actions: RuleActions }[] = [
    {
      // master-plan §2: qualifying ATM/cash deposits → Income:Salary.
      // Unscoped by account until accounts exist (direction+minimum limit
      // false hits; backfill review catches the rest).
      name: "ATM/cash deposit → Salary",
      priority: 10,
      conditions: { descriptionRegex: "ATM|CASH DEPOSIT", direction: "in", amountMinCents: 20_000 },
      actions: { categoryId: salary.id, merchantId: employer.id },
    },
    {
      // master-plan §2: descriptor-hint seed; Phase 3 transfer_detect pairs
      // the counterpart leg and owns ambiguous cases.
      name: "Card payment (thank you) → Transfer",
      priority: 20,
      conditions: { descriptionContains: "PAYMENT THANK YOU" },
      actions: { categoryId: cardPayment.id, markTransfer: true },
    },
  ];
  for (const r of seedRules) {
    summary.rules += tx
      .insert(rules)
      .values({
        name: r.name,
        priority: r.priority,
        conditions: JSON.stringify(r.conditions),
        actions: JSON.stringify(r.actions),
      })
      .onConflictDoNothing()
      .run().changes;
  }

  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    summary.settings += tx
      .insert(appSettings)
      .values({ key, value: JSON.stringify(value) })
      .onConflictDoNothing()
      .run().changes;
  }

  return summary;
}
