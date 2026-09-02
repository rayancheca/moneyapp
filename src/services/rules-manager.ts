import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { AppDatabase } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { categories } from "@/db/schema/categories";
import { merchants } from "@/db/schema/merchants";
import {
  rules,
  ruleActionsSchema,
  ruleConditionsSchema,
  type RuleActions,
  type RuleConditions,
} from "@/db/schema/rules";
import { humanizeDescriptionKey } from "@/lib/description-key";
import { countRuleChanges } from "./rule-corrections";

/**
 * The rules manager (ux-overhaul-plan §3.4): list rules as readable sentences,
 * enable/disable, reorder precedence, and preview how many transactions each
 * would change. Rules execute in ASCENDING priority, first match wins
 * (categorize.ts) — so the smallest priority is the TOP of the stack. The
 * manager shows and reorders them in that order.
 */

export interface RuleView {
  id: string;
  name: string;
  /** human-readable "When a transaction …, …" rendering of conditions+actions */
  sentence: string;
  isEnabled: boolean;
  priority: number;
  timesApplied: number;
  /** rows a retro-apply would actually CHANGE now (0 for row-less-action rules) */
  matchCount: number;
  isFirst: boolean;
  isLast: boolean;
}

/** An action changes transaction rows only if it sets one of these fields —
 * renameTo acts on the merchant entity, not rows, so a rename-only rule
 * matches descriptions but changes zero transactions (the over-report the
 * plan flags: countRuleMatches counts condition matches, not row changes). */
function hasRowAction(act: RuleActions): boolean {
  return (
    act.categoryId !== undefined ||
    act.merchantId !== undefined ||
    act.exclude === true ||
    act.markRecurringSeriesId !== undefined
  );
}

export interface SentenceContext {
  categoryLabel: (id: string) => string;
  merchantName: (id: string) => string;
  accountName: (id: string) => string;
}

function moneyPhrase(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

/** The conditions half: "is from Chase Checking and contains \"STARBUCKS\"". */
function conditionsPhrase(cond: RuleConditions, ctx: SentenceContext): string {
  const parts: string[] = [];
  if (cond.accountIds && cond.accountIds.length > 0) {
    parts.push(`is from ${cond.accountIds.map(ctx.accountName).join(" or ")}`);
  }
  if (cond.direction === "in") parts.push("is money in");
  if (cond.direction === "out") parts.push("is money out");
  if (cond.descriptionContains) parts.push(`contains "${cond.descriptionContains}"`);
  if (cond.descriptionKey) parts.push(`is named "${humanizeDescriptionKey(cond.descriptionKey)}"`);
  if (cond.descriptionRegex) parts.push(`matches /${cond.descriptionRegex}/`);
  if (cond.amountMinCents !== undefined && cond.amountMaxCents !== undefined) {
    parts.push(`is between ${moneyPhrase(cond.amountMinCents)} and ${moneyPhrase(cond.amountMaxCents)}`);
  } else if (cond.amountMinCents !== undefined) {
    parts.push(`is at least ${moneyPhrase(cond.amountMinCents)}`);
  } else if (cond.amountMaxCents !== undefined) {
    parts.push(`is at most ${moneyPhrase(cond.amountMaxCents)}`);
  }
  return parts.length > 0 ? parts.join(" and ") : "matches anything";
}

/** The actions half: "categorize it as Groceries and mark it a transfer". */
function actionsPhrase(act: RuleActions, ctx: SentenceContext): string {
  const parts: string[] = [];
  if (act.categoryId !== undefined) parts.push(`categorize it as ${ctx.categoryLabel(act.categoryId)}`);
  if (act.merchantId !== undefined) parts.push(`set its merchant to ${ctx.merchantName(act.merchantId)}`);
  if (act.markTransfer === true) parts.push("mark it a transfer");
  if (act.exclude === true) parts.push("exclude it");
  if (act.renameTo !== undefined) parts.push(`rename the merchant to "${act.renameTo}"`);
  if (act.markRecurringSeriesId !== undefined) parts.push("link it to a recurring series");
  return parts.length > 0 ? parts.join(" and ") : "do nothing";
}

export function renderRuleSentence(
  cond: RuleConditions,
  act: RuleActions,
  ctx: SentenceContext,
): string {
  return `When a transaction ${conditionsPhrase(cond, ctx)}, ${actionsPhrase(act, ctx)}.`;
}

export function sentenceContext(db: AppDatabase): SentenceContext {
  const cats = db
    .select({ id: categories.id, name: categories.name, parentId: categories.parentId })
    .from(categories)
    .all();
  const byId = new Map(cats.map((c) => [c.id, c]));
  const accs = new Map(
    db.select({ id: accounts.id, name: accounts.name }).from(accounts).all().map((a) => [a.id, a.name]),
  );
  const merch = new Map(
    db
      .select({ id: merchants.id, name: merchants.canonicalName })
      .from(merchants)
      .all()
      .map((m) => [m.id, m.name]),
  );
  return {
    categoryLabel: (id) => {
      const c = byId.get(id);
      if (!c) return "a category";
      const parent = c.parentId ? byId.get(c.parentId) : undefined;
      return parent ? `${parent.name} > ${c.name}` : c.name;
    },
    merchantName: (id) => merch.get(id) ?? "a merchant",
    accountName: (id) => accs.get(id) ?? "an account",
  };
}

/** Number of active non-user rows a retro-apply of these actions would change. */
export function previewRuleMatches(
  db: AppDatabase,
  cond: RuleConditions,
  act: RuleActions,
): number {
  if (!hasRowAction(act)) return 0;
  /*
   * ⛔ `countRuleChanges`, NOT `countRuleMatches`. The badge over this number
   * says "would change N", and `RuleView.matchCount` documents itself as "rows
   * a retro-apply would actually CHANGE now" — but the count was of CONDITION
   * matches, so /settings advertised "would change 19 · applied 11×" over a
   * rule that would move only the eight rows imported since. `countRuleChanges`
   * shares `retroApplyRule`'s own per-field guard, so the badge and the button
   * cannot disagree.
   */
  return countRuleChanges(db, cond, act);
}

/** The one precedence order — listRules and moveRule MUST agree on it. */
function orderedRules(db: AppDatabase) {
  return db.select().from(rules).orderBy(asc(rules.priority), asc(rules.name)).all();
}

export function listRules(db: AppDatabase): RuleView[] {
  const ctx = sentenceContext(db);
  const rows = orderedRules(db);
  return rows.map((r, i) => {
    const cond = ruleConditionsSchema.parse(JSON.parse(r.conditions));
    const act = ruleActionsSchema.parse(JSON.parse(r.actions));
    return {
      id: r.id,
      name: r.name,
      sentence: renderRuleSentence(cond, act, ctx),
      isEnabled: r.isEnabled,
      priority: r.priority,
      timesApplied: r.timesApplied,
      // a disabled rule doesn't run, so it advertises no pending changes and
      // offers no re-apply (the UI gates both on matchCount > 0)
      matchCount: r.isEnabled ? previewRuleMatches(db, cond, act) : 0,
      isFirst: i === 0,
      isLast: i === rows.length - 1,
    };
  });
}

export function setRuleEnabled(db: AppDatabase, ruleId: string, enabled: boolean): boolean {
  return (
    db.update(rules).set({ isEnabled: enabled }).where(eq(rules.id, ruleId)).run().changes > 0
  );
}

/** Enough of a rule to re-create it — the payload behind the delete Undo. */
export const ruleSnapshotSchema = z
  .object({
    name: z.string().min(1),
    priority: z.number().int(),
    isEnabled: z.boolean(),
    conditions: z.string().min(1),
    actions: z.string().min(1),
    timesApplied: z.number().int().nonnegative(),
  })
  .strict();
export type RuleSnapshot = z.infer<typeof ruleSnapshotSchema>;

/**
 * Deletes a rule and returns everything needed to restore it (its conditions,
 * actions, precedence, and applied history) — so delete gets the same lossless
 * Undo as every other mutation instead of being an irreversible config wipe.
 */
export function deleteRuleCapturing(db: AppDatabase, ruleId: string): RuleSnapshot | null {
  const row = db.select().from(rules).where(eq(rules.id, ruleId)).get();
  if (!row) return null;
  db.delete(rules).where(eq(rules.id, ruleId)).run();
  return {
    name: row.name,
    priority: row.priority,
    isEnabled: row.isEnabled,
    conditions: row.conditions,
    actions: row.actions,
    timesApplied: row.timesApplied,
  };
}

/** Re-creates a rule from its snapshot (the delete Undo). No-op on a name clash. */
export function restoreRule(db: AppDatabase, snapshot: RuleSnapshot): boolean {
  const parsed = ruleSnapshotSchema.parse(snapshot);
  return db.insert(rules).values(parsed).onConflictDoNothing().run().changes > 0;
}

/**
 * Reorder precedence by swapping priority with the adjacent rule in the
 * (priority asc, name asc) order the manager displays. "up" raises precedence
 * (toward the smallest priority = top of the stack); "down" lowers it. Swapping
 * the two priority VALUES is gap-agnostic; equal priorities (which can't be
 * reordered by swapping equal values) get a one-step nudge to establish a
 * strict order. Returns false at the ends or for an unknown id.
 */
export function moveRule(db: AppDatabase, ruleId: string, direction: "up" | "down"): boolean {
  const ordered = orderedRules(db);
  const idx = ordered.findIndex((r) => r.id === ruleId);
  if (idx < 0) return false;
  const swapIdx = direction === "up" ? idx - 1 : idx + 1;
  if (swapIdx < 0 || swapIdx >= ordered.length) return false;

  const rule = ordered[idx]!;
  const neighbor = ordered[swapIdx]!;
  if (rule.priority === neighbor.priority) {
    db.update(rules)
      .set({ priority: direction === "up" ? neighbor.priority - 1 : neighbor.priority + 1 })
      .where(eq(rules.id, rule.id))
      .run();
    return true;
  }
  db.transaction((tx) => {
    tx.update(rules).set({ priority: neighbor.priority }).where(eq(rules.id, rule.id)).run();
    tx.update(rules).set({ priority: rule.priority }).where(eq(rules.id, neighbor.id)).run();
  });
  return true;
}
