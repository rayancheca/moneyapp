import { describe, expect, test } from "vitest";
import { resolveCategoryIdentity } from "./category-identity";
import { isCategoryHueName } from "./category-palette";

describe("resolveCategoryIdentity", () => {
  test("known roots resolve to their assigned hue and icon", () => {
    expect(resolveCategoryIdentity("Food")).toEqual({ hue: "orange", icon: "utensils" });
    expect(resolveCategoryIdentity("Subscriptions")).toEqual({ hue: "indigo", icon: "repeat" });
  });

  test("Uncategorized is deliberately hueless", () => {
    expect(resolveCategoryIdentity("Uncategorized")).toEqual({ hue: null, icon: "tag" });
  });

  test("unknown root falls back to neutral tag", () => {
    expect(resolveCategoryIdentity("Custom Thing")).toEqual({ hue: null, icon: "tag" });
  });

  test("subcategory inherits root hue with its own icon when mapped", () => {
    expect(resolveCategoryIdentity("Groceries", "Food")).toEqual({
      hue: "orange",
      icon: "shopping-cart",
    });
  });

  test("subcategory without an icon override inherits the root icon", () => {
    expect(resolveCategoryIdentity("Home Supplies", "Housing")).toEqual({
      hue: "brown",
      icon: "house",
    });
  });

  test("subcategory under an unknown root falls back to neutral, keeping any icon override", () => {
    expect(resolveCategoryIdentity("Coffee", "Custom Root")).toEqual({ hue: null, icon: "coffee" });
    expect(resolveCategoryIdentity("Mystery", "Custom Root")).toEqual({ hue: null, icon: "tag" });
  });

  test("every assigned hue is a real palette hue", () => {
    const roots = [
      "Income",
      "Housing",
      "Utilities",
      "Food",
      "Transport",
      "Travel",
      "Shopping",
      "Subscriptions",
      "Health",
      "Entertainment",
      "Personal Care",
      "Education",
      "Gifts & Donations",
      "Cash & ATM",
      "Fees",
      "Rewards",
      "Transfers",
      "Investments",
    ];
    for (const root of roots) {
      const { hue } = resolveCategoryIdentity(root);
      expect(hue, root).not.toBeNull();
      expect(isCategoryHueName(hue!), `${root} hue ${hue} in palette`).toBe(true);
    }
  });
});
