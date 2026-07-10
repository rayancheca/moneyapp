import type { CategoryHueName } from "./category-palette";

/**
 * Default identity (hue + icon) for the seeded taxonomy. Subcategories inherit
 * their root's hue; a handful get their own icon. The seed backfills these into
 * categories.icon/color for isSystem rows only — user-created categories pick
 * identity in the category manager. Icon strings are Icon-component names.
 */

export interface CategoryIdentity {
  /** null = neutral (Uncategorized): chips render inkless gray */
  hue: CategoryHueName | null;
  icon: string;
}

const ROOT_IDENTITY: Record<string, CategoryIdentity> = {
  Income: { hue: "green", icon: "banknote" },
  Housing: { hue: "brown", icon: "house" },
  Utilities: { hue: "cyan", icon: "plug" },
  Food: { hue: "orange", icon: "utensils" },
  Transport: { hue: "blue", icon: "car" },
  Travel: { hue: "violet", icon: "plane" },
  Shopping: { hue: "pink", icon: "shopping-bag" },
  Subscriptions: { hue: "indigo", icon: "repeat" },
  Health: { hue: "red", icon: "heart-pulse" },
  Entertainment: { hue: "lime", icon: "ticket" },
  "Personal Care": { hue: "teal", icon: "smile" },
  Education: { hue: "amber", icon: "graduation-cap" },
  "Gifts & Donations": { hue: "pink", icon: "gift" },
  "Cash & ATM": { hue: "green", icon: "wallet" },
  Fees: { hue: "red", icon: "receipt" },
  Rewards: { hue: "amber", icon: "medal" },
  Transfers: { hue: "cyan", icon: "arrow-left-right" },
  Investments: { hue: "green", icon: "investments" },
  Uncategorized: { hue: null, icon: "tag" },
};

const SUB_ICONS: Record<string, string> = {
  Salary: "banknote",
  Groceries: "shopping-cart",
  Dining: "utensils",
  Coffee: "coffee",
  Streaming: "tv",
  Software: "code",
  Gas: "fuel",
  Rent: "key",
  Flights: "plane",
  Hotels: "bed",
  Fitness: "dumbbell",
  Pharmacy: "pill",
  Internet: "wifi",
  Mobile: "smartphone",
  Electricity: "zap",
  "ATM Withdrawals": "wallet",
};

const FALLBACK: CategoryIdentity = { hue: null, icon: "tag" };

/**
 * Resolve the default identity for a category. Roots resolve by name;
 * subcategories inherit the root hue and may override the icon.
 */
export function resolveCategoryIdentity(name: string, rootName?: string): CategoryIdentity {
  if (rootName === undefined) return ROOT_IDENTITY[name] ?? FALLBACK;
  const root = ROOT_IDENTITY[rootName] ?? FALLBACK;
  return { hue: root.hue, icon: SUB_ICONS[name] ?? root.icon };
}
