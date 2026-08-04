import { expect, test } from "@playwright/test";

/**
 * A cash wallet's opening balance edits in place on /accounts.
 *
 * The owner's report was "i added a cash account and balances didnt change":
 * a wallet created before the "Cash on hand" field existed — or with that box
 * left empty — opened at $0 and there was no way afterwards to say otherwise.
 * The service is unit-tested; what only a real render proves is the client
 * wiring, because <InlineEditableAmount> had never been mounted anywhere but a
 * transaction amount before this.
 *
 * The wallet is created inside the test rather than seeded: the e2e database is
 * shared with the sibling zz-specs, and a wallet carrying a balance would move
 * the net-worth figures several of them assert on. Naming it per-run keeps
 * parallel shards from colliding.
 *
 * zz-zz-zz- so it sorts DEAD LAST (workers: 1, fullyParallel: false, so file
 * order is alphabetical). At its first name, `zz-cash-…`, it ran BEFORE
 * zz-golden-path and its wallet row made that spec's full-page
 * accounts-managed-light baseline 32px taller — a spec creating an account is
 * only safe after every spec that photographs or totals one. It also restores
 * the opening to $0 at the end, the mutate-then-restore convention the inline
 * -edit specs use, so the only residue is an empty wallet.
 */

const WALLET = `E2E Wallet ${process.env.TEST_WORKER_INDEX ?? "0"}`;

test("a cash wallet's opening balance edits in place and moves its balance", async ({ page }) => {
  await page.goto("/accounts");

  await page.getByRole("button", { name: "New cash wallet" }).click();
  await page.getByRole("textbox", { name: "Wallet name" }).fill(WALLET);
  await page.getByRole("spinbutton", { name: "Cash on hand" }).fill("40");
  await page.getByRole("button", { name: "Create" }).click();

  const row = page.locator("li").filter({ hasText: WALLET });
  await expect(row).toBeVisible();
  // created with cash on hand: the opening AND the derived balance both read it
  await expect(row).toContainText("Opened with");
  const opening = row.getByRole("button", { name: `Opening cash for ${WALLET}` });
  await expect(opening).toHaveAttribute("aria-label", /\$40\.00/);

  // now edit it — the affordance that did not exist, and the owner's actual fix
  await opening.click();
  const input = row.getByRole("textbox", { name: `Opening cash for ${WALLET}` });
  await expect(input).toBeVisible();
  await input.fill("1800");
  await input.press("Enter");

  await expect(page.locator("body")).toContainText("Opening cash set to $1,800.00");
  await expect(
    row.getByRole("button", { name: `Opening cash for ${WALLET}` }),
  ).toHaveAttribute("aria-label", /\$1,800\.00/);

  // it PERSISTED and it moved the wallet's own balance — the whole point of the
  // report, and the thing a purely optimistic UI would fake
  await page.reload();
  const after = page.locator("li").filter({ hasText: WALLET });
  await expect(after.getByRole("button", { name: `Opening cash for ${WALLET}` })).toHaveAttribute(
    "aria-label",
    /\$1,800\.00/,
  );
  // The DERIVED balance specifically, not "the row contains $1,800.00" — the
  // row renders that figure twice (opening trigger + derived balance), so a
  // whole-row assertion is satisfied by the opening alone and would stay green
  // if derivation never re-ran. The derived figure is the sibling of the
  // "Add transaction" button, outside the opening's own subtitle.
  const derived = after.locator("div.flex.items-center.gap-3 .figures").first();
  await expect(derived).toHaveText("$1,800.00");

  // restore: leave the shared database without $1,800 of invented cash in it
  await after.getByRole("button", { name: `Opening cash for ${WALLET}` }).click();
  const back = after.getByRole("textbox", { name: `Opening cash for ${WALLET}` });
  await back.fill("0");
  await back.press("Enter");
  await expect(
    after.getByRole("button", { name: `Opening cash for ${WALLET}` }),
  ).toHaveAttribute("aria-label", /\$0\.00/);
});
