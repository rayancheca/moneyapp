import { expect, type Locator } from "@playwright/test";

/**
 * A layout box, waited for rather than grabbed.
 *
 * ## ⛔ `boundingBox()` does NOT auto-wait
 *
 * Almost every Playwright API retries until the element is ready. `boundingBox()`
 * is one of the few that does not: it asks the page for a rect right now and
 * returns `null` if the element is absent, detached, or has no layout box yet.
 * Written as `(await x.boundingBox())!.height` that is a `TypeError: Cannot read
 * properties of null (reading 'height')` — a message that names neither the
 * element nor the reason, and which is the FIRST thing in this suite to fall
 * over when the machine is busy.
 *
 * Measured, 2026-08-27: across five full runs on a loaded box, six specs failed
 * once each and none reproduced. The very first of them was exactly this —
 * `zz-card-deck`'s "the deck is a fraction of the grid" dereferencing a null box
 * on a page that had simply not finished painting. It passed in isolation, and
 * on a quiet box the whole suite is green in 7.9 minutes.
 *
 * ⚠️ This is the same trap pass 38 recorded for `isVisible()`, which also does
 * not wait and which turned a real assertion into a coin flip. The pattern is
 * worth naming: **a Playwright call that returns a value rather than asserting
 * one is usually the one that does not retry.**
 *
 * So: assert visibility first — `toBeVisible()` retries to the expect timeout,
 * which is precisely the wait that was missing — then read the box, and if it is
 * somehow still null, throw something a reader can act on.
 *
 * ⚠️ **The wait itself is not covered by a test, and cannot honestly be.**
 * Mutation-tested both halves: replacing the returned box with a fabricated one
 * fails four specs immediately, so the callers really do read this value — but
 * DELETING the `toBeVisible()` line breaks nothing, because on an idle machine
 * the element is already painted by the time `boundingBox()` asks. That is the
 * whole nature of the guard: it exists for a condition that only appears under
 * contention, which no assertion here can summon on demand. Recorded rather
 * than papered over with a test that would pass either way.
 *
 * @param what how to name this element when it has no box, e.g. "the card deck"
 */
export async function visibleBox(locator: Locator, what: string) {
  await expect(locator, `${what} should be on the page before its box is read`).toBeVisible();
  const box = await locator.boundingBox();
  if (!box) {
    /*
     * Reachable, and not merely defensive: `toBeVisible()` passes for an element
     * with a non-empty box OR `visibility: visible` content, while
     * `boundingBox()` returns null for one that is detached between the two
     * calls. Naming the element is the whole point — the raw failure names
     * nothing.
     */
    throw new Error(`${what} is visible but has no layout box`);
  }
  return box;
}
