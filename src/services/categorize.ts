import { and, asc, eq, inArray, isNull, ne, or } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { categories } from "@/db/schema/categories";
import { merchantAliases, merchants } from "@/db/schema/merchants";
import { rules, ruleActionsSchema, ruleConditionsSchema, type RuleConditions } from "@/db/schema/rules";
import { appSettings } from "@/db/schema/settings";
import { transactions } from "@/db/schema/transactions";
import { diffDays } from "@/lib/dates";
import { strippedDescriptionKey } from "@/lib/description-key";

/**
 * The categorization pipeline (master-plan §3). Precedence:
 * explicit user set > rules > merchant map > Claude. Claude fallback lives
 * in claude-categorize.ts; everything here is deterministic and free.
 */

const CREDIT_MATCH_WINDOW_DAYS = 30;

export interface CategorizeStats {
  processed: number;
  byRule: number;
  byMerchantMap: number;
  byBankCategory: number;
  byCreditMatch: number;
  uncategorized: number;
}

interface TxnRow {
  id: string;
  accountId: string;
  postedOn: string;
  amountCents: number;
  normalizedDescription: string;
  merchantId: string | null;
  categoryId: string | null;
  categorizationSource: string | null;
  bankCategory?: string | null;
}

/**
 * Bank-supplied category buckets → taxonomy paths (Chase spending-report
 * and card-CSV slugs). Deliberately conservative: ambiguous buckets
 * (PROFESSIONAL_SERVICES, MISCELLANEOUS) stay unmapped and fall through
 * to Claude. Runs AFTER the merchant map, so a known merchant's precise
 * subcategory always beats the bank's coarse bucket.
 */
const BANK_CATEGORY_MAP: Record<string, string> = {
  AUTOMOTIVE: "Transport",
  BILLS_AND_UTILITIES: "Utilities",
  ENTERTAINMENT: "Entertainment",
  FEES_AND_ADJUSTMENTS: "Fees",
  FOOD_AND_DRINK: "Food > Dining",
  GAS: "Transport > Gas",
  GROCERIES: "Food > Groceries",
  HEALTH_AND_WELLNESS: "Health",
  HOME: "Housing",
  PERSONAL: "Personal Care",
  SHOPPING: "Shopping",
  TRAVEL: "Travel",
  EDUCATION: "Education",
  GIFTS_AND_DONATIONS: "Gifts & Donations",
};

/** Resolve "Parent > Sub" (or bare parent) taxonomy paths to category ids. */
function bankCategoryIds(db: AppDatabase): Map<string, string> {
  const rows = db.select().from(categories).all();
  const byId = new Map(rows.map((r) => [r.id, r]));
  const byPath = new Map<string, string>();
  for (const r of rows) {
    const path = r.parentId ? `${byId.get(r.parentId)?.name} > ${r.name}` : r.name;
    byPath.set(path, r.id);
  }
  const out = new Map<string, string>();
  for (const [bucket, path] of Object.entries(BANK_CATEGORY_MAP)) {
    const id = byPath.get(path);
    if (id) out.set(bucket, id);
  }
  return out;
}

/** Enabled rules in precedence (priority asc), with parsed conditions/actions. */
export function loadRules(db: AppDatabase) {
  return db
    .select()
    .from(rules)
    .where(eq(rules.isEnabled, true))
    .orderBy(asc(rules.priority))
    .all()
    .map((r) => ({
      ...r,
      cond: ruleConditionsSchema.parse(JSON.parse(r.conditions)),
      act: ruleActionsSchema.parse(JSON.parse(r.actions)),
    }));
}

export function ruleMatches(cond: RuleConditions, txn: Pick<TxnRow, "accountId" | "amountCents" | "normalizedDescription">): boolean {
  if (cond.descriptionContains && !txn.normalizedDescription.includes(cond.descriptionContains.toUpperCase())) return false;
  if (cond.descriptionRegex && !new RegExp(cond.descriptionRegex, "i").test(txn.normalizedDescription)) return false;
  // Name-key equality: the merchantless "apply to this exact name" identity.
  // An empty stripped key would match every other empty-key row, so a rule can
  // never carry one (ruleConditionsSchema requires min(1)); guard anyway.
  if (cond.descriptionKey && strippedDescriptionKey(txn.normalizedDescription) !== cond.descriptionKey) return false;
  if (cond.accountIds && !cond.accountIds.includes(txn.accountId)) return false;
  if (cond.direction === "in" && txn.amountCents <= 0) return false;
  if (cond.direction === "out" && txn.amountCents >= 0) return false;
  if (cond.amountMinCents !== undefined && Math.abs(txn.amountCents) < cond.amountMinCents) return false;
  if (cond.amountMaxCents !== undefined && Math.abs(txn.amountCents) > cond.amountMaxCents) return false;
  return true;
}

interface AliasRow {
  pattern: string;
  matchType: "exact" | "prefix" | "contains";
  priority: number;
  merchantId: string;
}

export function matchAlias(aliases: readonly AliasRow[], normalized: string): string | null {
  const ranked = [...aliases].sort((a, b) => {
    const typeRank = { exact: 0, prefix: 1, contains: 2 };
    return typeRank[a.matchType] - typeRank[b.matchType] || b.priority - a.priority;
  });
  for (const a of ranked) {
    if (a.matchType === "exact" && normalized === a.pattern) return a.merchantId;
    if (a.matchType === "prefix" && normalized.startsWith(a.pattern)) return a.merchantId;
    if (a.matchType === "contains" && normalized.includes(a.pattern)) return a.merchantId;
  }
  return null;
}

function settingNumber(db: AppDatabase, key: string, fallback: number): number {
  const row = db.select().from(appSettings).where(eq(appSettings.key, key)).get();
  if (!row) return fallback;
  const parsed: unknown = JSON.parse(row.value);
  return typeof parsed === "number" ? parsed : fallback;
}

/** Runs the deterministic pipeline over every active, user-untouched, uncategorized txn. */
export function categorizeAll(db: AppDatabase): CategorizeStats {
  const stats: CategorizeStats = { processed: 0, byRule: 0, byMerchantMap: 0, byBankCategory: 0, byCreditMatch: 0, uncategorized: 0 };
  const activeRules = loadRules(db);
  const bankCatIds = bankCategoryIds(db);
  const aliases = db.select().from(merchantAliases).all();
  const merchantDefaults = new Map(
    db.select().from(merchants).all().map((m) => [m.id, m.defaultCategoryId]),
  );
  const reviewCreditThreshold = settingNumber(db, "reviewCreditThresholdCents", 20_000);
  const depositAccountIds = new Set(
    db.select({ id: accounts.id }).from(accounts).all()
      .filter((a) => false) // populated below with type info
      .map((a) => a.id),
  );
  for (const a of db.select().from(accounts).all()) {
    if (a.type === "checking" || a.type === "savings") depositAccountIds.add(a.id);
  }

  const pending = db
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      postedOn: transactions.postedOn,
      amountCents: transactions.amountCents,
      normalizedDescription: transactions.normalizedDescription,
      merchantId: transactions.merchantId,
      categoryId: transactions.categoryId,
      categorizationSource: transactions.categorizationSource,
      bankCategory: transactions.bankCategory,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.status, "active"),
        isNull(transactions.categoryId),
        // NULL != 'user' is NULL in SQL, not true — must be explicit
        or(isNull(transactions.categorizationSource), ne(transactions.categorizationSource, "user")),
      ),
    )
    .all() as TxnRow[];

  db.transaction((tx) => {
    for (const txn of pending) {
      stats.processed += 1;

      const rule = activeRules.find((r) => ruleMatches(r.cond, txn));
      if (rule) {
        tx.update(transactions)
          .set({
            categoryId: rule.act.categoryId ?? txn.categoryId,
            merchantId: rule.act.merchantId ?? txn.merchantId,
            categorizationSource: "rule",
            categorizationConfidence: 1,
            needsReview: false,
            ...(rule.act.exclude ? { status: "excluded" as const } : {}),
          })
          .where(eq(transactions.id, txn.id))
          .run();
        tx.update(rules).set({ timesApplied: rule.timesApplied + 1 }).where(eq(rules.id, rule.id)).run();
        stats.byRule += 1;
        continue;
      }

      const merchantId = txn.merchantId ?? matchAlias(aliases, txn.normalizedDescription);
      const defaultCategory = merchantId ? merchantDefaults.get(merchantId) : null;
      if (merchantId && defaultCategory) {
        tx.update(transactions)
          .set({
            merchantId,
            categoryId: defaultCategory,
            categorizationSource: "merchant_map",
            categorizationConfidence: 1,
            needsReview: false,
          })
          .where(eq(transactions.id, txn.id))
          .run();
        stats.byMerchantMap += 1;
        continue;
      }
      if (merchantId) {
        tx.update(transactions).set({ merchantId }).where(eq(transactions.id, txn.id)).run();
      }

      // bank-supplied bucket (Chase spending report / card CSV) — coarser
      // than the merchant map but far better than uncategorized
      const bankCategoryId = txn.bankCategory ? bankCatIds.get(txn.bankCategory) : undefined;
      if (bankCategoryId) {
        tx.update(transactions)
          .set({
            categoryId: bankCategoryId,
            categorizationSource: "bank_category",
            categorizationConfidence: 0.75,
            needsReview: false,
          })
          .where(eq(transactions.id, txn.id))
          .run();
        stats.byBankCategory += 1;
        continue;
      }

      if (txn.amountCents > 0) {
        const inherited = findCreditMatch(tx as unknown as AppDatabase, txn, merchantId);
        if (inherited) {
          tx.update(transactions)
            .set({
              categoryId: inherited,
              categorizationSource: "credit_match",
              categorizationConfidence: 0.9,
              needsReview: false,
            })
            .where(eq(transactions.id, txn.id))
            .run();
          stats.byCreditMatch += 1;
          continue;
        }
      }

      // still unknown — big inbound deposits are force-flagged for review
      // (master-plan §2); other uncategorized rows surface via coverage
      const bigCredit =
        txn.amountCents >= reviewCreditThreshold && depositAccountIds.has(txn.accountId);
      if (bigCredit) {
        tx.update(transactions).set({ needsReview: true }).where(eq(transactions.id, txn.id)).run();
      }
      stats.uncategorized += 1;
    }
  });

  return stats;
}

/** Credit matching (pipeline step 6): inherit the original purchase's category. */
function findCreditMatch(db: AppDatabase, credit: TxnRow, merchantId: string | null): string | null {
  const candidates = db
    .select({
      postedOn: transactions.postedOn,
      amountCents: transactions.amountCents,
      categoryId: transactions.categoryId,
      merchantId: transactions.merchantId,
      normalizedDescription: transactions.normalizedDescription,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.accountId, credit.accountId),
        eq(transactions.status, "active"),
      ),
    )
    .all();

  for (const c of candidates) {
    if (c.amountCents >= 0 || !c.categoryId) continue;
    const age = diffDays(c.postedOn, credit.postedOn);
    if (age < 0 || age > CREDIT_MATCH_WINDOW_DAYS) continue;
    if (Math.abs(credit.amountCents) > Math.abs(c.amountCents)) continue;
    const sameMerchant = merchantId !== null && c.merchantId === merchantId;
    const similarDesc =
      c.normalizedDescription !== "" &&
      (credit.normalizedDescription.includes(c.normalizedDescription) ||
        c.normalizedDescription.includes(credit.normalizedDescription));
    if (sameMerchant || similarDesc) return c.categoryId;
  }
  return null;
}

const TRANSFER_HINT_RE =
  /PAYMENT THANK YOU|AUTOPAY|ONLINE PYMT|DIRECTPAY|ONLINE TRANSFER|TRANSFER TO|TRANSFER FROM|BANK TRANSFER|ROBINHOOD|CRD EPAY|CARDMEMBER SERV/i;

/**
 * Pairing windows (P0.5a). HINTED pairs stretch to ±10 calendar days — ACH
 * settlement floats 3–9 business days, so the chunked Chase→SoFi / SoFi→RH
 * migration legs sit further apart than the old ±4. UNHINTED coincidences
 * keep the original ±4 ambiguity flagging: a bare equal-cent match 5–10 days
 * out is ignored, exactly as before the widen (no new review noise).
 */
const HINTED_PAIR_WINDOW_DAYS = 10;
const AMBIGUITY_WINDOW_DAYS = 4;

/**
 * SoFi's internal savings↔checking movements (overdraft covers, manual
 * moves) are same-day, descriptor-symmetric mirrors (ground truth §7; the
 * verified 241↔241 overdraft set matches by exact date). A one-sided hint
 * must never let a foreign row claim one of these legs — the real-data
 * dry-run showed AAPL buys, subscription fees, and third-party Zelle rows
 * doing exactly that. A family leg is pair-eligible ONLY with a same-day
 * family mirror (which is itself the hint); everything else falls through
 * to the ambiguity/review path.
 */
const INTERNAL_MIRROR_RE = /(OVERDRAFT|WITHDRAWAL|DEPOSIT)\s+(TO|FROM)\s+(SAVINGS|CHECKING)/i;

/**
 * Zelle and ATM rows are RESERVED for the user: they asked (2026-07-13) to
 * tag every one of them themselves, one by one — so the detector neither
 * pairs them nor adds them to ambiguity flags, even for perfect mirrors.
 * The S5 manual "Link as transfer…" flow covers them.
 */
const RESERVED_FOR_USER_RE = /ZELLE|\bATM\b/i;

/**
 * Card-payment descriptors (autopay, e-payment, thank-you postings) describe
 * money moving to a CREDIT CARD — a pair carrying one may only join a leg in
 * a credit-type account. Without this, SoFi's "CHASE CREDIT CRD EPAY" legs
 * (whose true mirror lives in the not-yet-imported Sapphire card) grabbed
 * equal-cent checking transfers in the real-data dry-run.
 */
const CARD_PAYMENT_RE =
  /PAYMENT THANK YOU|AUTOPAY|ONLINE PYMT|DIRECTPAY|E-PAYMENT|MOBILE PMT|MOBILE PYMT|CRD EPAY|CARDMEMBER SERV/i;

/** A ROBINHOOD descriptor names an institution — the pair must touch it. */
const ROBINHOOD_RE = /ROBINHOOD|\bRH\b|\bRHS\b/i;

export interface TransferStats {
  paired: number;
  flaggedAmbiguous: number;
}

function categoryIdByPath(db: AppDatabase, path: string): string {
  const [parentName, subName] = path.split(" > ");
  const parent = db
    .select()
    .from(categories)
    .where(and(eq(categories.name, parentName!), isNull(categories.parentId)))
    .get();
  if (!parent) throw new Error(`Missing category ${parentName}`);
  if (!subName) return parent.id;
  const sub = db
    .select()
    .from(categories)
    .where(and(eq(categories.name, subName), eq(categories.parentId, parent.id)))
    .get();
  if (!sub) throw new Error(`Missing category ${path}`);
  return sub.id;
}

/**
 * Transfer pairing: opposite equal-cent amounts across two accounts. Pairs
 * ONLY with a hint — a descriptor match, the S6 card↔source link, or both
 * legs already categorized under Transfers; coincidental equal amounts go to
 * review instead (Phase 3 acceptance criterion). Hinted pairs match within
 * ±10 days (ACH float).
 *
 * Resolved so EVIDENCE, not proximity, drives every auto-pair (four adversarial
 * review rounds, 2026-07-15). A pair auto-commits only when it is AUTO-PAIRABLE —
 * structural evidence (a same-day internal mirror, the S6 card↔source link, or
 * both legs already in Transfers) OR a hint on BOTH descriptors — AND the two are
 * MUTUALLY unique-nearest (each is the other's unique nearest eligible leg). A
 * hint on only ONE leg is never enough: it says "this row is a transfer" but not
 * WHICH counterpart is its partner, so single-sided pairs (an ACH bridge with a
 * generic other leg, or a coincidental equal-cent match) go to REVIEW, not an
 * auto-pair. Two passes:
 *   1. Pair every auto-pairable, mutually-nearest match (fixpoint so consuming one
 *      leg unlocks another's now-unique match); the same-day OVERDRAFT mirror
 *      multiset resolves deterministically by id.
 *   2. Flag the rest for review — a hinted outflow with equal-cent candidates
 *      surfaces all of them; an unhinted outflow surfaces only a ±4d coincidence.
 * ELIGIBILITY: a leg already categorized OUTSIDE the Transfers subtree (by any
 * source — a real Buy/Dividend/Reward, a rule/merchant map, or the user) is
 * off-limits and never relabeled a transfer.
 */
export function detectTransfers(db: AppDatabase): TransferStats {
  const stats: TransferStats = { paired: 0, flaggedAmbiguous: 0 };
  const accountRows = db.select().from(accounts).all();
  const accountTypes = new Map(accountRows.map((a) => [a.id, a.type]));

  // S6: a user-declared card↔funding-account link counts as a hint — payments
  // between the linked pair auto-pair even without a descriptor match
  const linkedPairs = new Set<string>();
  for (const a of accountRows) {
    if (a.paymentSourceAccountId) {
      linkedPairs.add(`${a.id}\x1f${a.paymentSourceAccountId}`);
      linkedPairs.add(`${a.paymentSourceAccountId}\x1f${a.id}`);
    }
  }
  const isLinkedPair = (x: string, y: string): boolean => linkedPairs.has(`${x}\x1f${y}`);

  const candidates = db
    .select()
    .from(transactions)
    .where(and(eq(transactions.status, "active"), isNull(transactions.transferGroupId)))
    .orderBy(asc(transactions.postedOn))
    .all();

  const cardPaymentCat = categoryIdByPath(db, "Transfers > Credit Card Payment");
  const internalCat = categoryIdByPath(db, "Transfers > Internal Transfer");
  const investmentCat = categoryIdByPath(db, "Transfers > Investment Contribution");

  // the Transfers subtree: both legs already carrying one of these categories
  // is itself a hint (P0.5a) — and the boundary of the user-decision guard
  const transfersParent = db
    .select()
    .from(categories)
    .where(and(eq(categories.name, "Transfers"), isNull(categories.parentId)))
    .get();
  const transferCatIds = new Set<string>(transfersParent ? [transfersParent.id] : []);
  if (transfersParent) {
    for (const c of db.select().from(categories).where(eq(categories.parentId, transfersParent.id)).all()) {
      transferCatIds.add(c.id);
    }
  }
  const inTransfers = (categoryId: string | null): boolean => categoryId !== null && transferCatIds.has(categoryId);

  // A leg may enter pairing only if it is UNKNOWN (uncategorized, and not a row the
  // user explicitly cleared) or already believed to be a transfer (categorized within
  // the Transfers subtree). A leg already categorized OUTSIDE Transfers — by ANY source:
  // a real Buy / Dividend / Reward / bill, a rule or merchant map, or the user — is
  // off-limits. Transfer detection must never silently relabel a genuine categorization
  // as a transfer (2026-07-15 review: a real "Investments › Buys" row was overwritten
  // because only categorizationSource==='user' was protected).
  const ineligible = (t: (typeof candidates)[number]): boolean =>
    RESERVED_FOR_USER_RE.test(t.rawDescription) ||
    (t.categoryId !== null && !transferCatIds.has(t.categoryId)) ||
    (t.categorizationSource === "user" && t.categoryId === null);

  const mirrorCompatible = (x: (typeof candidates)[number], y: (typeof candidates)[number]): boolean => {
    const xm = INTERNAL_MIRROR_RE.test(x.rawDescription);
    const ym = INTERNAL_MIRROR_RE.test(y.rawDescription);
    if (!xm && !ym) return true;
    return xm && ym && x.postedOn === y.postedOn;
  };
  const semanticsCompatible = (x: (typeof candidates)[number], y: (typeof candidates)[number]): boolean => {
    const types = [accountTypes.get(x.accountId), accountTypes.get(y.accountId)];
    if ((CARD_PAYMENT_RE.test(x.rawDescription) || CARD_PAYMENT_RE.test(y.rawDescription)) && !types.includes("credit"))
      return false;
    if ((ROBINHOOD_RE.test(x.rawDescription) || ROBINHOOD_RE.test(y.rawDescription)) && !types.includes("investment"))
      return false;
    return true;
  };

  const anchorHinted = (a: (typeof candidates)[number]): boolean => TRANSFER_HINT_RE.test(a.rawDescription);
  // AUTO-PAIRABLE: the two SPECIFIC rows carry MUTUAL evidence of being a pair. Four
  // adversarial review rounds (2026-07-15) established that a descriptor hint on only ONE
  // leg is never sufficient — it says "this row is a transfer" but not WHICH counterpart is
  // its partner, so among equal-cent candidates it silently pairs coincidences (a wine
  // purchase vs an external wire; a paycheck vs an external transfer; a landlord check vs an
  // incoming transfer), especially when the hinted leg's true partner isn't in the ledger.
  // Only STRUCTURAL evidence (a same-day internal mirror, the S6 card↔source link, or both
  // legs already in Transfers) or a hint on BOTH descriptors auto-pairs; a single-sided hint
  // goes to review. (mirrorCompatible already forces same-day for any mirror leg.)
  const autoPairable = (a: (typeof candidates)[number], b: (typeof candidates)[number]): boolean =>
    (INTERNAL_MIRROR_RE.test(a.rawDescription) && INTERNAL_MIRROR_RE.test(b.rawDescription)) ||
    isLinkedPair(a.accountId, b.accountId) ||
    (inTransfers(a.categoryId) && inTransfers(b.categoryId)) ||
    (TRANSFER_HINT_RE.test(a.rawDescription) && TRANSFER_HINT_RE.test(b.rawDescription));

  const dist = (a: (typeof candidates)[number], b: (typeof candidates)[number]): number =>
    Math.abs(diffDays(a.postedOn, b.postedOn));

  // index inflows by exact cents so matching is O(bucket), not O(all-candidates)
  const inflowsByAmount = new Map<number, (typeof candidates)[number][]>();
  for (const c of candidates) {
    if (c.amountCents <= 0) continue;
    const bucket = inflowsByAmount.get(c.amountCents);
    if (bucket) bucket.push(c);
    else inflowsByAmount.set(c.amountCents, [c]);
  }

  const used = new Set<string>();
  const eligibleOutflow = (a: (typeof candidates)[number]): boolean =>
    !used.has(a.id) && a.amountCents < 0 && !ineligible(a);
  const matchesFor = (a: (typeof candidates)[number]): (typeof candidates)[number][] =>
    (inflowsByAmount.get(-a.amountCents) ?? []).filter(
      (b) =>
        !used.has(b.id) &&
        b.accountId !== a.accountId &&
        !ineligible(b) &&
        mirrorCompatible(a, b) &&
        semanticsCompatible(a, b) &&
        dist(a, b) <= HINTED_PAIR_WINDOW_DAYS,
    );
  const nearestOf = (a: (typeof candidates)[number], ms: (typeof candidates)[number][]) => {
    const minDist = Math.min(...ms.map((m) => dist(a, m)));
    return { minDist, nearest: ms.filter((m) => dist(a, m) === minDist) };
  };

  // Reverse index: an inflow's eligible outflow candidates. A confident pair may commit
  // only when it is MUTUALLY nearest — the inflow's OWN nearest outflow is this anchor —
  // so an earlier or unrelated outflow can never steal an inflow from its true partner
  // merely by being reached first in the loop (2026-07-15 re-review: an unhinted "CHECK
  // TO LANDLORD" was stealing a hinted inflow from the real ACH transfer, whose evidence
  // — the inflow's hint — said nothing about which outflow was the partner).
  const outflowsByAmount = new Map<number, (typeof candidates)[number][]>();
  for (const c of candidates) {
    if (c.amountCents >= 0) continue;
    const bucket = outflowsByAmount.get(c.amountCents);
    if (bucket) bucket.push(c);
    else outflowsByAmount.set(c.amountCents, [c]);
  }
  const outflowMatchesForInflow = (b: (typeof candidates)[number]): (typeof candidates)[number][] =>
    (outflowsByAmount.get(-b.amountCents) ?? []).filter(
      (o) =>
        !used.has(o.id) &&
        o.accountId !== b.accountId &&
        !ineligible(o) &&
        mirrorCompatible(o, b) &&
        semanticsCompatible(o, b) &&
        dist(o, b) <= HINTED_PAIR_WINDOW_DAYS,
    );
  // true when `a` is `b`'s UNIQUE nearest eligible outflow — the inflow's own vote for `a`
  const isNearestOutflow = (b: (typeof candidates)[number], a: (typeof candidates)[number]): boolean => {
    const os = outflowMatchesForInflow(b);
    if (os.length === 0) return false;
    const { nearest } = nearestOf(b, os);
    return nearest.length === 1 && nearest[0]!.id === a.id;
  };

  db.transaction((tx) => {
    const commitPair = (a: (typeof candidates)[number], b: (typeof candidates)[number]): void => {
      const groupId = a.id; // deterministic group key: the outflow leg's id
      const types = [accountTypes.get(a.accountId), accountTypes.get(b.accountId)];
      const computed = types.includes("credit")
        ? cardPaymentCat
        : types.includes("investment")
          ? investmentCat
          : internalCat;
      // if exactly one leg is user-tagged, the whole group adopts that leg's category so
      // both sides of a transferGroupId always agree; otherwise use the account-type category
      const userLeg = [a, b].find((l) => l.categorizationSource === "user" && l.categoryId !== null);
      const groupCategory = userLeg ? userLeg.categoryId! : computed;
      for (const leg of [a, b]) {
        const set =
          leg.categorizationSource === "user"
            ? { transferGroupId: groupId, needsReview: false }
            : {
                transferGroupId: groupId,
                categoryId: groupCategory,
                categorizationSource: "transfer_detect" as const,
                categorizationConfidence: 0.95,
                needsReview: false,
              };
        tx.update(transactions).set(set).where(eq(transactions.id, leg.id)).run();
      }
      used.add(a.id);
      used.add(b.id);
      stats.paired += 1;
    };

    // PASS 1 (fixpoint): the ONLY auto-pairing pass. Commit a pair when it is AUTO-PAIRABLE
    // (structural evidence or both descriptors hinted) AND mutually unique-nearest — the
    // outflow's unique nearest inflow, and that inflow's unique nearest outflow — so no leg
    // is claimed by a coincidence or stolen by a rival. Iterated so consuming one leg can
    // unlock another's now-unique match; the same-day OVERDRAFT mirror multiset resolves
    // deterministically by id. No single-sided-hint pairing exists — those go to review.
    let progress = true;
    while (progress) {
      progress = false;
      for (const a of candidates) {
        if (!eligibleOutflow(a)) continue;
        const ms = matchesFor(a);
        if (ms.length === 0) continue;
        const { minDist, nearest } = nearestOf(a, ms);
        if (nearest.length === 1 && autoPairable(a, nearest[0]!) && isNearestOutflow(nearest[0]!, a)) {
          commitPair(a, nearest[0]!);
          progress = true;
        } else if (
          nearest.length > 1 &&
          minDist === 0 &&
          INTERNAL_MIRROR_RE.test(a.rawDescription) &&
          nearest.every((m) => m.postedOn === a.postedOn && INTERNAL_MIRROR_RE.test(m.rawDescription))
        ) {
          commitPair(a, [...nearest].sort((x, y) => (x.id < y.id ? -1 : 1))[0]!);
          progress = true;
        }
      }
    }

    // PASS 2: flag the ambiguous/single-sided remainder for human review. Any outflow that
    // carries a transfer hint but still holds equal-cent candidate(s) — a single-sided ACH
    // bridge, competing chunks, or a hint-only coincidence — surfaces ALL its candidates;
    // an unhinted outflow surfaces only a NEAR (±4d) coincidence (far bare matches ignored,
    // no review noise). Non-consuming: every contended outflow is surfaced, none dropped
    // (re-review finding: a hinted outflow that lost a shared candidate must still be seen).
    const flag = (a: (typeof candidates)[number], legs: (typeof candidates)[number][]): void => {
      const ids = [...new Set([a.id, ...legs.map((m) => m.id)])];
      tx.update(transactions).set({ needsReview: true }).where(inArray(transactions.id, ids)).run();
      stats.flaggedAmbiguous += 1;
    };
    for (const a of candidates) {
      if (!eligibleOutflow(a)) continue;
      const ms = matchesFor(a);
      if (ms.length === 0) continue;
      if (anchorHinted(a)) {
        flag(a, ms);
      } else {
        const near = ms.filter((m) => dist(a, m) <= AMBIGUITY_WINDOW_DAYS);
        if (near.length > 0) flag(a, near);
      }
    }
  });
  return stats;
}

export interface CorrectionInput {
  transactionId: string;
  categoryId: string;
  /** update the merchant's default mapping (subject to the direction guard) */
  applyToMerchant?: boolean;
  /** user explicitly confirmed a sign-opposing mapping change */
  confirmDirectionOverride?: boolean;
  /** recategorize this merchant's non-user history */
  retroactive?: boolean;
}

export interface CorrectionResult {
  merchantUpdated: boolean;
  directionGuardTriggered: boolean;
  retroactivelyUpdated: number;
}

/** User corrections: permanent on the txn; merchant map behind the direction guard. */
export function applyCorrection(db: AppDatabase, input: CorrectionInput): CorrectionResult {
  const txn = db.select().from(transactions).where(eq(transactions.id, input.transactionId)).get();
  if (!txn) throw new Error("Unknown transaction");

  const result: CorrectionResult = {
    merchantUpdated: false,
    directionGuardTriggered: false,
    retroactivelyUpdated: 0,
  };

  db.transaction((tx) => {
    tx.update(transactions)
      .set({
        categoryId: input.categoryId,
        categorizationSource: "user",
        categorizationConfidence: 1,
        needsReview: false,
      })
      .where(eq(transactions.id, input.transactionId))
      .run();

    if (!input.applyToMerchant || !txn.merchantId) return;

    const siblings = tx
      .select({ amountCents: transactions.amountCents })
      .from(transactions)
      .where(and(eq(transactions.merchantId, txn.merchantId), eq(transactions.status, "active")))
      .all();
    const negatives = siblings.filter((s) => s.amountCents < 0).length;
    const dominantNegative = negatives >= siblings.length / 2;
    const opposesDominant = dominantNegative ? txn.amountCents > 0 : txn.amountCents < 0;

    if (opposesDominant && !input.confirmDirectionOverride) {
      result.directionGuardTriggered = true; // txn-only; mapping untouched
      return;
    }

    tx.update(merchants)
      .set({ defaultCategoryId: input.categoryId, mappingSource: "user" })
      .where(eq(merchants.id, txn.merchantId))
      .run();
    result.merchantUpdated = true;

    if (input.retroactive) {
      const updated = tx
        .update(transactions)
        .set({ categoryId: input.categoryId, categorizationSource: "merchant_map" })
        .where(
          and(
            eq(transactions.merchantId, txn.merchantId),
            eq(transactions.status, "active"),
            or(isNull(transactions.categorizationSource), ne(transactions.categorizationSource, "user")),
            ne(transactions.id, txn.id),
          ),
        )
        .run();
      result.retroactivelyUpdated = updated.changes;
    }
  });

  return result;
}

export interface CoverageStats {
  total: number;
  categorized: number;
  coveragePct: number;
  needsReview: number;
}

export function coverageStats(db: AppDatabase): CoverageStats {
  const rows = db
    .select({ categoryId: transactions.categoryId, needsReview: transactions.needsReview })
    .from(transactions)
    .where(eq(transactions.status, "active"))
    .all();
  const total = rows.length;
  const categorized = rows.filter((r) => r.categoryId !== null).length;
  return {
    total,
    categorized,
    coveragePct: total === 0 ? 100 : Math.round((categorized / total) * 1000) / 10,
    needsReview: rows.filter((r) => r.needsReview).length,
  };
}
