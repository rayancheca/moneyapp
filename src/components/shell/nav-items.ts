export interface NavItem {
  href: string;
  label: string;
  icon:
    | "dashboard"
    | "accounts"
    | "imports"
    | "transactions"
    | "spending"
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
  // Transfers sit next to Spending because that is the question they answer:
  // "where did the money go" splits into what LEFT (spending) and what merely
  // MOVED (flow). The Sankey deliberately excludes the latter.
  { href: "/flow", label: "Flow", icon: "flow" },
  { href: "/budgets", label: "Budgets", icon: "budgets" },
  { href: "/recurring", label: "Recurring", icon: "recurring" },
  { href: "/investments", label: "Investments", icon: "investments" },
  { href: "/settings", label: "Settings", icon: "settings" },
];
