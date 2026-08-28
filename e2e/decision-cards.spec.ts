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
 * A real figure: money or a percentage, optionally signed, optionally marked
 * approximate, optionally carrying a short unit qualifier.
 *
 * Built by DUMPING every `.figures` value this section actually renders rather
 * than by guessing — the shapes are `$0.00`, `+$15,430.28`, `-$205.40`, `+12%`,
 * `12.7%`, and `+66.22% in total` / `+25.21% a year` / `+39.36% of cost`.
 *
 * The `+` matters: a DELTA prints its direction where a balance does not.
 * The trailing qualifier matters more: those three percentages are a cumulative
 * total, a rate per year and a ratio to cost, and stacking them WITHOUT their
 * units is the misreading the performance card exists to prevent — bare, 66%
 * looks like it beat 25%. The words are the figure.
 *
 * Still tight on purpose: at most three lowercase words, so `—`, `N/A`, `TBD`,
 * `NaN` and `Infinity` all fail. `MONEY` above stays stricter for the runway's
 * rows, which really are balances.
 */
const MONEY_OR_PCT = /^(≈ ?)?[+-−]?(\$[\d,]+\.\d{2}|[\d,]+(\.\d+)?%)( [a-z]+){0,3}$/;

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

  /**
   * ⚠️ Widened from "is money" to "is a real figure" when the section grew past
   * the two cards it was written for. `.figures` is TYPOGRAPHIC — mono plus
   * tabular numerals (globals.css) — not a claim that a value is a currency
   * amount, and a percentage in a tabular column is exactly what it is for. The
   * movers card publishes a `-15%` change beside its money and was right to.
   *
   * The assertion this test actually exists to make is unchanged: every figure
   * is REAL DATA and never a placeholder. Loosening the shape while keeping the
   * placeholder sweep below is the honest edit; deleting the test because a new
   * card disagreed with its premise would not be.
   */
  test("every figure on the card is real data, never a placeholder", async ({ page }) => {
    const card = page.locator("section:has(#decisions-heading)");
    const figures = await card.locator("dd .figures, dd span.figures").allInnerTexts();
    expect(figures.length).toBeGreaterThan(0);
    for (const f of figures) {
      expect(f.trim(), `"${f}" should be money or a percentage`).toMatch(MONEY_OR_PCT);
    }
    await expect(card.getByText(/NaN|Infinity|undefined|\$0\.00 of cash/)).toHaveCount(0);
    // −0 renders as "-$0.00" and reads as a debt rounded down; it shipped once
    await expect(card.getByText(/^-\$0\.00$|^−\$0\.00$/)).toHaveCount(0);
  });

  /**
   * ⛔ This test used to assert the OPPOSITE — that the car card is absent —
   * because the fixture had no top-level Car category and `carCard` returns null
   * without one. That made it one of three cards no baseline had ever seen, so
   * §9 of the seed gives the fixture a car: the category plus two commitments
   * overridden into it with `userCategoryId`, which is how a lease signed before
   * its first charge reaches a category at all. Not a cent moves.
   *
   * The absence case is still covered — by `committed.test.ts`, against a ledger
   * built without a Car category, which is where a null-return belongs.
   */
  test("the car card names what the car costs a month", async ({ page }) => {
    const card = page.locator("section:has(#decisions-heading)");
    await expect(card.getByText("The car", { exact: true })).toHaveCount(1);
    // $450.00 lease + $128.00 insurance, and the card says what it is measuring
    await expect(card.getByText(/a month, all in/)).toHaveCount(1);
    /*
     * ⚠️ Counted, not `toBeVisible`. The deck shows ONE card at a time and holds
     * the rest at `opacity: 0` — which is exactly why nine of its ten cards had
     * no pixel coverage until `?cards=grid` was photographed. A visibility
     * assertion here would be asserting which card the deck happens to open on.
     */
    await expect(card.getByText("$578.00", { exact: true })).toHaveCount(1);
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
