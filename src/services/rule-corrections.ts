import { eq } from "drizzle-orm";
import { withPreMutationSnapshot } from "@/db/backup";
import type { AppDatabase } from "@/db/client";
import { categories } from "@/db/schema/categories";
import { merchantAliases, merchants } from "@/db/schema/merchants";
import {
  rules,
  ruleActionsSchema,
  ruleConditionsSchema,
  type RuleConditions,
} from "@/db/schema/rules";
import {
  transactions,
  type CategorizationSource,
  type TransactionStatus,
} from "@/db/schema/transactions";
import { humanizeDescriptionKey } from "@/lib/description-key";
import { ruleMatches } from "./categorize";
import type { UndoFields, UndoPatch } from "./bulk-edit";

/**
 * Correction-becomes-rule (ux-overhaul-plan §3.4). Retro-apply is a NEW
 * predicate, not categorizeAll: it hits matching ACTIVE rows regardless of
 * their current category, skipping only categorizationSource='user' rows —
 * user decisions are never overwritten by a non-user path. countRuleMatches
 * (the toast's N) uses the identical row set.
 */

export interface CorrectionRuleInput {
  merchantId?: string;
  descriptionContains?: string;
  /** stripped-key equality — the merchantless "this exact name" identity */
  descriptionKey?: string;
  categoryId: string;
}

export interface CreatedRule {
  id: string;
  name: string;
  priority: number;
  conditions: RuleConditions;
}

const ALIAS_TYPE_RANK: Record<string, number> = { contains: 0, prefix: 1, exact: 2 };

/**
 * RuleConditions cannot express merchant_id (the engine matches
 * descriptions), so a merchant correction bridges through the merchant's
 * broadest alias: 'contains' aliases are short description cores, 'prefix'
 * next, 'exact' patterns are full normalized strings (narrow but correct as
 * substrings). Falls back to the uppercased canonical name.
 */
export function conditionsForCorrection(
  db: AppDatabase,
  input: { merchantId?: string; descriptionContains?: string; descriptionKey?: string },
): RuleConditions {
  if (input.descriptionContains !== undefined) {
    return ruleConditionsSchema.parse({
      descriptionContains: input.descriptionContains.toUpperCase(),
    });
  }
  if (input.descriptionKey !== undefined) {
    return ruleConditionsSchema.parse({ descriptionKey: input.descriptionKey });
  }
  if (!input.merchantId) {
    throw new Error("A merchant, a name key, or a description fragment is required");
  }
  const merchant = db.select().from(merchants).where(eq(merchants.id, input.merchantId)).get();
  if (!merchant) throw new Error("Unknown merchant");

  const aliases = db
    .select()
    .from(merchantAliases)
    .where(eq(merchantAliases.merchantId, merchant.id))
    .all();
  const best = [...aliases].sort(
    (a, b) =>
      (ALIAS_TYPE_RANK[a.matchType] ?? 9) - (ALIAS_TYPE_RANK[b.matchType] ?? 9) ||
      b.priority - a.priority,
  )[0];
  const pattern = best?.pattern ?? merchant.canonicalName.toUpperCase();
  return ruleConditionsSchema.parse({ descriptionContains: pattern });
}

/**
 * The engine executes rules in ASCENDING priority, first match wins
 * (categorize.ts loadRules) — "top of the stack" is therefore the SMALLEST
 * number. Newest-on-top (§3.4's one precedence model) = current min − 10.
 */
function topPriority(db: AppDatabase): number {
  const priorities = db.select({ p: rules.priority }).from(rules).all().map((r) => r.p);
  return (priorities.length > 0 ? Math.min(...priorities) : 10) - 10;
}

function uniqueRuleName(db: AppDatabase, base: string): string {
  const existing = new Set(db.select({ name: rules.name }).from(rules).all().map((r) => r.name));
  if (!existing.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base} (${n})`;
    if (!existing.has(candidate)) return candidate;
  }
}

/** Creates an enabled rule at top precedence from a user correction. */
export function ruleFromCorrection(db: AppDatabase, input: CorrectionRuleInput): CreatedRule {
  const category = db.select().from(categories).where(eq(categories.id, input.categoryId)).get();
  if (!category) throw new Error("Unknown category");

  const conditions = conditionsForCorrection(db, input);
  const actions = ruleActionsSchema.parse({
    categoryId: input.categoryId,
    ...(input.merchantId ? { merchantId: input.merchantId } : {}),
  });

  const merchant = input.merchantId
    ? db.select().from(merchants).where(eq(merchants.id, input.merchantId)).get()
    : undefined;
  const subject =
    merchant?.canonicalName ??
    (conditions.descriptionKey ? humanizeDescriptionKey(conditions.descriptionKey) : undefined) ??
    conditions.descriptionContains ??
    "match";
  const name = uniqueRuleName(db, `Always: ${subject} → ${category.name}`);
  const priority = topPriority(db);

  const id = db
    .insert(rules)
    .values({
      name,
      priority,
      isEnabled: true,
      conditions: JSON.stringify(conditions),
      actions: JSON.stringify(actions),
    })
    .returning({ id: rules.id })
    .get().id;

  return { id, name, priority, conditions };
}

interface MatchableTxn {
  id: string;
  accountId: string;
  amountCents: number;
  normalizedDescription: string;
  categorizationSource: CategorizationSource | null;
  categoryId: string | null;
  categorizationConfidence: number | null;
  needsReview: boolean;
  status: TransactionStatus;
  merchantId: string | null;
  recurringSeriesId: string | null;
}

/** THE retro-apply predicate — countRuleMatches and retroApplyRule share it. */
function matchingRows(
  db: AppDatabase,
  conditions: RuleConditions,
  opts: { excludeUserSet: boolean },
): MatchableTxn[] {
  return db
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      amountCents: transactions.amountCents,
      normalizedDescription: transactions.normalizedDescription,
      categorizationSource: transactions.categorizationSource,
      categoryId: transactions.categoryId,
      categorizationConfidence: transactions.categorizationConfidence,
      needsReview: transactions.needsReview,
      status: transactions.status,
      merchantId: transactions.merchantId,
      recurringSeriesId: transactions.recurringSeriesId,
    })
    .from(transactions)
    .where(eq(transactions.status, "active"))
    .all()
    .filter(
      (t) =>
        (!opts.excludeUserSet || t.categorizationSource !== "user") && ruleMatches(conditions, t),
    );
}

/** The number shown in the rule-prompt toast BEFORE the rule exists. */
export function countRuleMatches(
  db: AppDatabase,
  conditions: RuleConditions,
  opts: { excludeUserSet: boolean },
): number {
  return matchingRows(db, ruleConditionsSchema.parse(conditions), opts).length;
}

export interface RetroApplyResult {
  affected: number;
  undo: UndoPatch;
}

/**
 * Applies a rule's actions to every matching non-user active row. Honors
 * categoryId / merchantId / exclude (mirroring the live engine) plus the new
 * markRecurringSeriesId; renameTo acts on merchant entities, not transaction
 * rows, and is wired by the Stage-2 rules manager.
 */
export function retroApplyRule(db: AppDatabase, ruleId: string): RetroApplyResult {
  const rule = db.select().from(rules).where(eq(rules.id, ruleId)).get();
  if (!rule) throw new Error("Unknown rule");
  const conditions = ruleConditionsSchema.parse(JSON.parse(rule.conditions));
  const actions = ruleActionsSchema.parse(JSON.parse(rule.actions));

  const rows = matchingRows(db, conditions, { excludeUserSet: true });
  const undoRows: UndoPatch["rows"] = [];

  const apply = () => {
    db.transaction((tx) => {
      for (const row of rows) {
        const prev: UndoFields = {};
        const set: Partial<typeof transactions.$inferInsert> = {};
        // Every assignment is guarded on a REAL change: a row that already
        // carries the rule's outcome has not moved, and writing it anyway
        // inflates timesApplied and reports a blast radius ("re-applied to N")
        // that no row actually felt. Fields are guarded individually because a
        // row can already sit in the right category while still being flagged
        // for review or stamped by a weaker source — settling those IS a change.
        if (actions.categoryId !== undefined) {
          if (row.categoryId !== actions.categoryId) {
            prev.categoryId = row.categoryId;
            set.categoryId = actions.categoryId;
          }
          if (row.categorizationSource !== "rule") {
            prev.categorizationSource = row.categorizationSource;
            set.categorizationSource = "rule";
          }
          if (row.categorizationConfidence !== 1) {
            prev.categorizationConfidence = row.categorizationConfidence;
            set.categorizationConfidence = 1;
          }
          if (row.needsReview) {
            prev.needsReview = row.needsReview;
            set.needsReview = false;
          }
        }
        if (actions.merchantId !== undefined && row.merchantId !== actions.merchantId) {
          prev.merchantId = row.merchantId;
          set.merchantId = actions.merchantId;
        }
        if (actions.exclude && row.status !== "excluded") {
          prev.status = row.status;
          set.status = "excluded";
        }
        if (
          actions.markRecurringSeriesId !== undefined &&
          row.recurringSeriesId !== actions.markRecurringSeriesId
        ) {
          prev.recurringSeriesId = row.recurringSeriesId;
          set.recurringSeriesId = actions.markRecurringSeriesId;
        }
        if (Object.keys(set).length === 0) continue;
        tx.update(transactions).set(set).where(eq(transactions.id, row.id)).run();
        undoRows.push({ id: row.id, prev });
      }
      if (undoRows.length > 0) {
        tx.update(rules)
          .set({ timesApplied: rule.timesApplied + undoRows.length })
          .where(eq(rules.id, rule.id))
          .run();
      }
    });
  };

  // Retro-apply hands back an undo patch, but that patch lives only as long as
  // the toast that holds it — one navigation and the rewrite is permanent. A
  // rule that matches nothing rewrites nothing, so it needs no restore point.
  if (rows.length === 0) apply();
  else withPreMutationSnapshot(db, "retro-apply-rule", apply);

  return { affected: undoRows.length, undo: { rows: undoRows } };
}

/** Undo for "create rule" reverts the rule itself too (§3.0). */
export function deleteRule(db: AppDatabase, ruleId: string): boolean {
  return db.delete(rules).where(eq(rules.id, ruleId)).run().changes > 0;
}
