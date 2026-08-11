export interface NavItem {
  href: string;
  label: string;
  icon:
    | "dashboard"
    | "accounts"
    | "imports"
    | "transactions"
    | "spending"
    | "tag"
    | "flow"
    | "budgets"
    | "recurring"
    | "investments"
    | "settings";
}

export const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Dashboard", icon: "dashboard" },
  { href: "/accounts", label: "Accounts", icon: "accounts" },
  { href: "/imports", label: "Imports", icon: "imports" },
  { href: "/transactions", label: "Transactions", icon: "transactions" },
  { href: "/spending", label: "Spending", icon: "spending" },
  { href: "/categories", label: "Categories", icon: "tag" },
  // Transfers sit next to Spending because that is the question they answer:
  // "where did the money go" splits into what LEFT (spending) and what merely
  // MOVED (flow). The Sankey deliberately excludes the latter.
  { href: "/flow", label: "Flow", icon: "flow" },
  { href: "/budgets", label: "Budgets", icon: "budgets" },
  { href: "/recurring", label: "Recurring", icon: "recurring" },
  { href: "/investments", label: "Investments", icon: "investments" },
  { href: "/settings", label: "Settings", icon: "settings" },
];

/**
 * Accessible name for a nav item carrying badges.
 *
 * The pills themselves are `aria-hidden`, so this string is the only thing a
 * screen reader gets. The review-only branch is byte-identical to what it has
 * always been — the e2e suite and the a11y specs assert on it.
 *
 * "duplicate pairs", never "possible duplicates": the count is of candidate
 * PAIRS, and two identical charges in each of two files produce four of them.
 */
export function navLabel(label: string, reviewCount: number, duplicateCount: number): string | undefined {
  const pairs = (n: number): string => `${n} duplicate pair${n === 1 ? "" : "s"} to resolve`;
  if (reviewCount > 0 && duplicateCount > 0) {
    return `${label}, ${reviewCount} to review, ${pairs(duplicateCount)}`;
  }
  if (reviewCount > 0) return `${label}, ${reviewCount} to review`;
  if (duplicateCount > 0) return `${label}, ${pairs(duplicateCount)}`;
  return undefined;
}
