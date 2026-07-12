import { expect, test } from "@playwright/test";

/**
 * The guided categorize walk (ux-overhaul-plan §3.2 — the learning loop). The
 * seed plants a deterministic review backlog; the review view offers a one-by-one
 * pass that opens the transaction card on each flagged row, tracks progress, and
 * auto-advances when a category is set. This spec drives the contract read-only
 * except for a single correction that it advances past (the shared seed's flagged
 * set only shrinks, which sibling specs tolerate — they assert counts, not a
 * fixed backlog). Runs before zz-golden-path (alphabetical) which mutates last.
 */

test("the review view walks the backlog one card at a time, advancing on categorize", async ({
  page,
}) => {
  await page.goto("/transactions?view=review");

  await expect(page.getByRole("heading", { name: "Categorize one by one" })).toBeVisible();
  const start = page.getByRole("button", { name: /Start · \d+/ });
  await expect(start).toBeVisible();
  const total = Number((await start.textContent())!.match(/\d+/)![0]);
  expect(total).toBeGreaterThan(2);

  // opens the card on the first flagged row with a progress counter
  await start.click();
  const card = page.getByRole("dialog");
  await expect(card).toBeVisible();
  await expect(card).toContainText(`1 of ${total}`);

  // flip forward and back through the queue
  await card.getByRole("button", { name: "Next transaction" }).click();
  await expect(card).toContainText(`2 of ${total}`);
  await card.getByRole("button", { name: "Previous transaction" }).click();
  await expect(card).toContainText(`1 of ${total}`);

  // setting a category auto-advances to the next card — the learning rhythm
  await card.getByRole("button", { name: /^Category: .* Change$/ }).click();
  await page.getByRole("listbox", { name: "Categories" }).getByRole("option").nth(2).click();
  await expect(card).toContainText(`2 of ${total}`);

  // Esc leaves the walk and returns to the launcher
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByRole("button", { name: /Start · \d+/ })).toBeVisible();
});
