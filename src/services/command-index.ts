import { asc, eq } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { categories } from "@/db/schema/categories";
import { holdings } from "@/db/schema/holdings";
import { institutions } from "@/db/schema/institutions";
import { merchants } from "@/db/schema/merchants";
import { hrefCategoryId } from "./analytics";
import { ledgerHref } from "@/lib/ledger-href";
import { isIconName, type IconName } from "@/components/shell/Icon";
import type { CommandPaletteGroup } from "@/components/ui/CommandPalette";

/**
 * Entity index for the ⌘K palette (ux-overhaul-plan §3.8): accounts, categories,
 * and merchants become searchable, each navigating to its surface. Built
 * server-side per request (the palette is client-side search over this list)
 * and merged with the static Pages group in the shell.
 */

export function commandEntityGroups(db: AppDatabase): CommandPaletteGroup[] {
  const groups: CommandPaletteGroup[] = [];

  const accountRows = db
    .select({ id: accounts.id, name: accounts.name, institution: institutions.name })
    .from(accounts)
    .innerJoin(institutions, eq(accounts.institutionId, institutions.id))
    .where(eq(accounts.isActive, true))
    .orderBy(asc(institutions.name), asc(accounts.name))
    .all();
  if (accountRows.length > 0) {
    groups.push({
      label: "Accounts",
      items: accountRows.map((a) => ({
        id: `account-${a.id}`,
        label: a.name,
        hint: a.institution,
        icon: "accounts" as IconName,
        href: `/accounts/${a.id}`,
        keywords: [a.institution],
      })),
    });
  }

  // categories navigate to their filtered ledger until /categories/[id] lands
  // (Stage 3). The id→name map spans ALL categories so a child whose parent is
  // archived still renders "Parent > Child". `categories.icon` is an
  // unconstrained, user/Claude-editable text column, so junk degrades to "tag"
  // via isIconName — the same guard CategoryChip uses (never trust it raw).
  const catNameById = new Map(
    db.select({ id: categories.id, name: categories.name }).from(categories).all().map((c) => [c.id, c.name]),
  );
  const catRows = db
    .select({ id: categories.id, name: categories.name, parentId: categories.parentId, icon: categories.icon, kind: categories.kind })
    .from(categories)
    .where(eq(categories.isArchived, false))
    .orderBy(asc(categories.sortOrder), asc(categories.name))
    .all();
  if (catRows.length > 0) {
    groups.push({
      label: "Categories",
      items: catRows.map((c) => {
        const parentName = c.parentId ? catNameById.get(c.parentId) : undefined;
        return {
          id: `category-${c.id}`,
          label: parentName ? `${parentName} > ${c.name}` : c.name,
          hint: "Category",
          icon: isIconName(c.icon) ? c.icon : ("tag" as IconName),
          /*
           * ⛔ Through `ledgerHref`, and the system "Uncategorized" row goes in
           * as the BUCKET. A link carrying its raw id filters by that id alone,
           * and `activeTxnsInRange` normalises every such row to null — so the
           * palette's "Uncategorized" opened the six rows hand-filed on the
           * category out of the 37 the bucket holds.
           *
           * ⛔ `hrefCategoryId`, not `kind === "system"` spelled out again. The
           * first draft hand-rolled the test in the same commit that created
           * the rule to hold it — identical today, and exactly the second copy
           * the rule exists to prevent.
           */
          href: ledgerHref({ category: hrefCategoryId(db, c.id) }),
          ...(parentName ? { keywords: [parentName] } : {}),
        };
      }),
    });
  }

  // No LIMIT: a single user's merchant set is bounded personal data (dozens,
  // not thousands) and this is a local-first app, so the whole list is worth
  // making searchable rather than silently truncating findability.
  const merchantRows = db
    .select({ id: merchants.id, name: merchants.canonicalName })
    .from(merchants)
    .orderBy(asc(merchants.canonicalName))
    .all();
  if (merchantRows.length > 0) {
    groups.push({
      label: "Merchants",
      items: merchantRows.map((m) => ({
        id: `merchant-${m.id}`,
        label: m.name,
        hint: "Merchant",
        icon: "tag" as IconName,
        href: `/merchants/${m.id}`,
      })),
    });
  }

  // Holdings become searchable, opening the aggregated holding page. Deduped by
  // (assetType, symbol) since the same symbol can be held in more than one account.
  const holdingRows = db
    .select({ symbol: holdings.symbol, assetType: holdings.assetType })
    .from(holdings)
    .where(eq(holdings.isActive, true))
    .orderBy(asc(holdings.symbol))
    .all();
  const seen = new Set<string>();
  const uniqueHoldings = holdingRows.filter((h) => {
    const key = `${h.assetType}/${h.symbol}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (uniqueHoldings.length > 0) {
    groups.push({
      label: "Holdings",
      items: uniqueHoldings.map((h) => ({
        id: `holding-${h.assetType}-${h.symbol}`,
        label: h.symbol,
        hint: "Holding",
        icon: "investments" as IconName,
        href: `/investments/${h.assetType}/${h.symbol}`,
      })),
    });
  }

  return groups;
}
