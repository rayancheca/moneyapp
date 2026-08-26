import { expect, test } from "@playwright/test";

/**
 * The pass-63 decision cards on the dashboard.
 *
 * ⚠️ **This fixture renders the `covered` branch, not the `burning` one.** The
 * seeded ledger earns more per month than it spends, so the runway reads "Your
 * income covers your spending" — while the owner's real database reads "19 days
 * of cash". A component-level assertion about the burning branch would pass here
 * whether or not it were right, which is exactly why both branches are pinned in
 * `src/lib/runway.test.ts` under the 100%-branch gate. What this spec is for is
 * the half unit tests cannot see: that the section renders at all, that its
 * arithmetic survives the round trip through the service and the DOM, and that
 * the car half correctly does NOT render on a ledger with no car.
 *
 * Deliberately not `zz-`-prefixed: those run after the fixture mutators, and
 * this spec is read-only.
 */

const MONEY = /^-?−?\$[\d,]+\.\d{2}$/;

/**
 * Every dt/dd pair in the card, as plain data.
 *
 * A `dt` carrying an InfoTip also carries the tooltip's BODY in its
 * textContent — the popover is live DOM text even while closed — so labels are
 * matched by prefix, never by equality. Reading the rows in one evaluate is
 * also what lets the arithmetic assertion below compare them to each other.
 */
async function rows(card: import("@playwright/test").Locator) {
  return card.locator("dl > div").evaluateAll((els) =>
    els.map((el) => ({
      label: (el.querySelector("dt")?.textContent ?? "").trim(),
      value: (el.querySelector("dd")?.textContent ?? "").trim(),
    })),
  );
}

const valueOf = (all: { label: string; value: string }[], label: string): string => {
  const hit = all.find((r) => r.label.startsWith(label));
  if (!hit) throw new Error(`no row labelled "${label}" — saw ${all.map((r) => r.label.slice(0, 30))}`);
  return hit.value;
};

/** "$1,234.56" or "−$1,234.56" → cents, sign included. */
function toCents(text: string): number {
  const negative = text.trim().startsWith("−") || text.trim().startsWith("-");
  const digits = Number(text.replace(/[^\d.]/g, ""));
  return Math.round(digits * 100) * (negative ? -1 : 1);
}

test.describe("dashboard decision cards", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("the runway card states a verdict and the money behind it", async ({ page }) => {
    const card = page.locator("section:has(#decisions-heading)");
    await expect(card).toBeVisible();

    // the heading's accessible name includes its InfoTip's, so match the start
    await expect(card.getByRole("heading", { level: 3, name: /^Runway/ })).toBeVisible();

    // every assumption the answer rests on is named AND priced
    const all = await rows(card);
    for (const label of [
      "Cash you can spend today",
      "Less what you owe on cards",
      "What you spend a month",
      "What you earn a month",
      "Net cash",
    ]) {
      expect(valueOf(all, label), label).toMatch(MONEY);
    }
  });

  test("net cash is exactly the cash rows, so the column reads as arithmetic", async ({ page }) => {
    const card = page.locator("section:has(#decisions-heading)");
    const all = await rows(card);

    const liquid = toCents(valueOf(all, "Cash you can spend today"));
    const cards = toCents(valueOf(all, "Less what you owe on cards"));
    const net = toCents(valueOf(all, "Net cash"));

    expect(liquid).toBeGreaterThan(0);
    // the subtraction is PRINTED as one — a bare positive in a column of
    // positives is what shipped first, and it read as a balance
    expect(cards).toBeLessThan(0);
    expect(net).toBe(liquid + cards);
  });

  test("each assumption links somewhere the reader can check it", async ({ page }) => {
    const card = page.locator("section:has(#decisions-heading)");
    await expect(card.getByRole("link", { name: "Cash you can spend today" })).toHaveAttribute(
      "href",
      "/accounts",
    );
    await expect(card.getByRole("link", { name: "What you spend a month" })).toHaveAttribute(
      "href",
      "/spending",
    );
  });

  test("every figure on the card is real money, never a placeholder", async ({ page }) => {
    const card = page.locator("section:has(#decisions-heading)");
    const figures = await card.locator("dd .figures, dd span.figures").allInnerTexts();
    expect(figures.length).toBeGreaterThan(0);
    for (const f of figures) {
      expect(f.trim(), `"${f}" should be formatted money`).toMatch(MONEY);
    }
    await expect(card.getByText(/NaN|Infinity|undefined|\$0\.00 of cash/)).toHaveCount(0);
  });

  /**
   * `carCard` returns null when the ledger has no top-level Car category, and
   * the fixture has none. A card of zeroes would be worse than no card, so the
   * absence is the correct render and is asserted rather than assumed.
   */
  test("the car card is absent on a ledger with no car", async ({ page }) => {
    const card = page.locator("section:has(#decisions-heading)");
    await expect(card.getByText("The car", { exact: true })).toHaveCount(0);
    await expect(card.getByText(/a month, all in/)).toHaveCount(0);
  });

  /**
   * The eating-out card, whose figures the fixture renders INVERTED relative to
   * the owner's ledger: seeded, groceries ($3,262.12 over 45 trips in the
   * window) outrun eating out ($871.27 over 46 visits), where his real database
   * reads 10.1× the other way. That is the useful accident — the sub-1×
   * branch of the ratio sentence gets exercised here and nowhere else, and a
   * card that only ever rendered "10.1×" would never have proved it can render
   * "0.3×" without saying something silly.
   */
  /**
   * ⚠️ `SurfaceCard` renders a `<section>`, not a div — so each card is a
   * nested section inside the one carrying `#decisions-heading`. Scoping to
   * `div` and taking `.first()` selects the GRID container instead, which
   * silently widens every row query to all three cards at once. The subtotal
   * assertion below would then be summing rows that belong to the runway.
   */
  const eatingOutCard = (page: import("@playwright/test").Page) =>
    page
      .locator("section:has(#decisions-heading) section")
      .filter({ has: page.getByRole("heading", { level: 3, name: "Eating out" }) })
      .first();

  test("the eating-out card separates eating out from groceries", async ({ page }) => {
    const card = eatingOutCard(page);
    await expect(card.getByRole("heading", { level: 3, name: "Eating out" })).toBeVisible();

    const all = await rows(card);
    // the subtotal row is the one labelled "Eating out"; groceries sit below it
    expect(valueOf(all, "Eating out")).toMatch(MONEY);
    expect(valueOf(all, "Groceries")).toMatch(MONEY);
  });

  /**
   * ⛔ The subtotal must equal ONLY the eating-out rows. Groceries sit directly
   * under it and are the thing being compared against, not a component — if
   * they ever leak into the sum, the card's whole point (isolating one habit)
   * is gone and the number silently becomes a different number.
   */
  test("the eating-out subtotal excludes groceries", async ({ page }) => {
    const card = eatingOutCard(page);
    const all = await rows(card);

    const subtotal = toCents(valueOf(all, "Eating out"));
    const groceries = toCents(valueOf(all, "Groceries"));
    const components = all
      .filter((r) => ["Dining", "Delivery", "Coffee"].some((n) => r.label.startsWith(n)))
      .reduce((sum, r) => sum + toCents(r.value), 0);

    expect(components).toBeGreaterThan(0);
    expect(subtotal).toBe(components);
    expect(subtotal).not.toBe(components + groceries);
  });

  /**
   * `x / 0` is Infinity and would render as "Infinity× what you spend on
   * groceries". The unit test pins the service; this pins that nothing on the
   * way to the DOM reintroduces it.
   */
  test("the ratio never renders as Infinity or NaN", async ({ page }) => {
    const card = eatingOutCard(page);
    await expect(card.getByText(/Infinity|NaN|undefined/)).toHaveCount(0);
    await expect(card.getByText(/× what you spend on groceries/)).toBeVisible();
  });

  test("the section is reachable by keyboard and named for screen readers", async ({ page }) => {
    await expect(page.locator("#decisions-heading")).toHaveText("What this means");
    const link = page.locator("section:has(#decisions-heading)").getByRole("link").first();
    await link.focus();
    await expect(link).toBeFocused();
  });
});
