import { expect, test } from "@playwright/test";

/**
 * The decision cards as a stack you swipe, wheel or arrow through.
 *
 * Owner, 2026-08-27: *"instead of having the cards take up al the space in teh
 * world and having to scroll down to see them just stack them on thop of each
 * other … that way you can add as many as you want without flooding the page"*.
 *
 * ## ⚠️ Why this spec exists SEPARATELY from `decision-cards.spec.ts`
 *
 * Every test in that file still passes against the deck, and that is not the
 * reassurance it looks like. Playwright's `toBeVisible()` means "has a box and
 * is not `display:none`/`visibility:hidden`" — an `opacity: 0` card eleven deep
 * in a stack satisfies it. Those tests read CONTENT and always did; nothing
 * there can tell a deck from a grid.
 *
 * So the layout is asserted here, and the assertions are about the things that
 * would actually be broken: exactly one card at the front, a section that is a
 * fraction of the grid's height, and every way in still leading somewhere.
 *
 * ## ⛔ Why `zz-`, and why every goto names its lens
 *
 * Choosing the grid PERSISTS — `saveViewPreferenceAction` writes it to
 * app_settings, which is the point of the control. That makes this a fixture
 * MUTATOR, and the first run of it proved the danger inside its own file: the
 * switch test left the grid selected and the next test found no deck at all.
 * Unprefixed, it sorts before `decision-cards` and `visual` and would have
 * silently rebased eight dashboard baselines onto the grid.
 *
 * So: `zz-` so it runs after the read-only specs, every navigation names its
 * own `?cards=` (a URL beats a preference), and the one test that must click
 * the control puts it back.
 */

const SECTION = "section:has(#decisions-heading)";
const DECK = '[aria-roledescription="card deck"]';

async function frontHeading(page: import("@playwright/test").Page): Promise<string> {
  return (await page.locator(`${DECK} [aria-current="true"] h3`).first().innerText()).trim();
}

test.describe("the card deck", () => {
  test("shows one card at a time, and says which", async ({ page }) => {
    await page.goto("/?cards=deck");
    const deck = page.locator(DECK);
    await expect(deck).toBeVisible();

    // exactly one front card, however many the deck holds
    await expect(page.locator(`${DECK} > [aria-current="true"]`)).toHaveCount(1);

    // and the position is announced, because a stack shifting is not a fact a
    // screen reader can observe
    await expect(page.locator(`${SECTION} p[aria-live]`)).toContainText(/card 1 of \d+/);
  });

  test("⛔ the deck is a fraction of the grid it replaced", async ({ page }) => {
    /*
     * The whole point. If this ever inverts, the feature has silently stopped
     * doing the one thing it was built for — and no content test would notice.
     */
    await page.goto("/?cards=deck");
    const deckHeight = (await page.locator(SECTION).boundingBox())!.height;
    await page.goto("/?cards=grid");
    const gridHeight = (await page.locator(SECTION).boundingBox())!.height;
    expect(deckHeight).toBeLessThan(gridHeight / 2);
  });

  test("every way in leads somewhere: arrows, Home, End, and a pip", async ({ page }) => {
    await page.goto("/?cards=deck");
    const deck = page.locator(DECK);
    await deck.scrollIntoViewIfNeeded();
    const first = await frontHeading(page);

    await deck.focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(`${SECTION} p[aria-live]`)).toContainText("card 2 of");
    const second = await frontHeading(page);
    expect(second).not.toBe(first);

    await page.keyboard.press("ArrowLeft");
    await expect(page.locator(`${SECTION} p[aria-live]`)).toContainText("card 1 of");

    await page.keyboard.press("End");
    const last = await page.locator(`${SECTION} p[aria-live]`).innerText();
    expect(last).toMatch(/card (\d+) of \1/);

    await page.keyboard.press("Home");
    await expect(page.locator(`${SECTION} p[aria-live]`)).toContainText("card 1 of");

    // a pip jumps straight there — the deck is random-access, not only stepwise
    const pips = page.locator(`${SECTION} button[aria-current], ${SECTION} button`).filter({ hasText: "" });
    await pips.last().click();
    expect(await frontHeading(page)).not.toBe(first);
  });

  test("⚠️ dragging LEFT advances, and a short drag snaps back", async ({ page }) => {
    // backwards here is the most common way a carousel feels wrong, and it is
    // completely invisible in a screenshot
    await page.goto("/?cards=deck");
    const deck = page.locator(DECK);
    await deck.scrollIntoViewIfNeeded();
    const box = (await deck.boundingBox())!;
    const y = box.y + 60;

    const drag = async (dx: number) => {
      await page.mouse.move(box.x + box.width * 0.7, y);
      await page.mouse.down();
      const steps = 8;
      for (let i = 1; i <= steps; i += 1) {
        await page.mouse.move(box.x + box.width * 0.7 + (dx * i) / steps, y, { steps: 2 });
      }
      await page.mouse.up();
    };

    await drag(-box.width * 0.5);
    await expect(page.locator(`${SECTION} p[aria-live]`)).toContainText("card 2 of");

    // a nudge is not a decision
    await drag(-12);
    await expect(page.locator(`${SECTION} p[aria-live]`)).toContainText("card 2 of");

    await drag(box.width * 0.5);
    await expect(page.locator(`${SECTION} p[aria-live]`)).toContainText("card 1 of");
  });

  test("⛔ nothing is lost — every card is still in the document", async ({ page }) => {
    /*
     * A stack that unmounted eleven cards would be a filter wearing an
     * animation: gone from the accessibility tree, gone from find-in-page, and
     * gone from anything that reads the page. The deck is PRESENTATION.
     */
    await page.goto("/?cards=deck");
    const inDeck = await page.locator(`${SECTION} h3`).count();
    await page.goto("/?cards=grid");
    const inGrid = await page.locator(`${SECTION} h3`).count();
    expect(inDeck).toBe(inGrid);
    expect(inDeck).toBeGreaterThan(1);
  });

  test("the grid is still one switch away, and the switch is a real control", async ({ page }) => {
    await page.goto("/?cards=deck");
    const group = page.getByRole("group", { name: "How the cards are laid out" });
    await expect(group.getByRole("button", { name: "Deck" })).toHaveAttribute("aria-pressed", "true");
    await group.getByRole("button", { name: "Grid" }).click();
    await expect(page.locator(DECK)).toHaveCount(0);
    await expect(group.getByRole("button", { name: "Grid" })).toHaveAttribute("aria-pressed", "true");

    // ⛔ put it back. The click PERSISTED, and a spec that leaves the fixture on
    // a different layout rebases every dashboard baseline that runs after it.
    await group.getByRole("button", { name: "Deck" }).click();
    await expect(page.locator(DECK)).toBeVisible();
  });
});

test.describe("neutral notices", () => {
  test("⛔ describes, and never judges or advises", async ({ page }) => {
    /*
     * The owner travels and drives an EV; three charges once flagged as
     * "card-testing probes" were every one of them legitimate. The vocabulary's
     * own sweep test guards the TEMPLATES; this guards what actually reached
     * the page, including the summary line the templates do not own.
     */
    await page.goto("/?cards=grid");
    const card = page
      .locator(`${SECTION} section`)
      .filter({ has: page.getByRole("heading", { level: 3, name: "Worth a look" }) });

    /*
     * ⚠️ MEASURED, not assumed: the e2e fixture produces ZERO notices — no
     * merchant in it has a single large first charge, none has six sightings
     * with an eightfold outlier, and no series drifts. So this branch is the
     * one that runs today, and an early `return` here would have been a silent
     * pass dressed as coverage.
     *
     * The card's own content is covered by 18 unit tests against a ledger whose
     * answers are known (`services/notices-card.test.ts`), and the wording is
     * covered by the vocabulary's neutrality sweep. What is NOT covered is its
     * rendering — noted in the handoff beside `/merchants/[id]`, which has the
     * same gap for the same reason: seeding it would move every dashboard,
     * spending and transactions baseline for one card.
     */
    if ((await card.count()) === 0) {
      expect(await page.locator(`${SECTION} h3`).allInnerTexts()).not.toContain("Worth a look");
      return;
    }
    const text = await card.innerText();
    expect(text).not.toMatch(
      /\b(should|must|need to|consider|suspicious|unusual|fraud|too much|excessive|worrying|alarming)\b/i,
    );
    // and it says what it looked at, so an empty card would be a measurement
    expect(text).toMatch(/description, not a verdict/);
  });
});

test.describe("reduced motion", () => {
  test("the stack still works, and nothing animates", async ({ page }) => {
    /*
     * ⚠️ `test.use({ reducedMotion: "reduce" })` was tried first and does NOT
     * reach the page in this config — measured, not assumed:
     * `matchMedia("(prefers-reduced-motion: reduce)").matches` came back
     * `false` and the container kept its height transition. `emulateMedia` is
     * what the rest of this suite already uses (`year-summary` emulates print
     * the same way) and it works.
     */
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/?cards=deck");
    const deck = page.locator(DECK);
    await expect(deck).toBeVisible();
    // the container's height transition is the one layout property this
    // component animates; under reduce it must not
    await expect(deck).toHaveCSS("transition", /none/);
    await deck.focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(`${SECTION} p[aria-live]`)).toContainText("card 2 of");
  });
});
