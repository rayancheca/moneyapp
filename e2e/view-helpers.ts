import { expect, type Page, type Request, type Route } from "@playwright/test";

/**
 * Pressing a PERSISTED view pill, for specs that must leave the view the way they found it.
 *
 * Every segmented control built on `useViewState` (src/hooks/useViewState.ts) does two
 * things on a press, in this order: it AWAITS `saveViewPreferenceAction` (the press is
 * written to app_settings), and only then `router.push`es the new view's URL. There is no
 * optimistic state: the pill's `aria-pressed` comes from the server-resolved view, so it
 * flips only once that navigation has committed — after the write landed. A pill reporting
 * itself pressed is therefore the app's own proof that the press is durable.
 *
 * A bare `click()` proves none of it, and two things go wrong after one:
 *
 * - A `page.goto` fired before the write lands reads the OLD preference on the server, and
 *   if the page goes away first the write is never even sent. That was
 *   `networth-bridge.spec.ts`'s restore step, seen once in ~15 gates. Made slow on purpose
 *   (below), the next `/` came back on the bridge's own Table, and "Net worth over time"
 *   was nowhere on it — the gate's exact message.
 * - A second press made before the first one's navigation commits was computed from the
 *   view the server resolved BEFORE the first press, and `setView` persists the whole
 *   view — so it wrote the first dimension straight back. The post-suite e2e database of
 *   a 602/602 gate (2026-10-01) still held `dashboard.bridgeLens: "table"` after that
 *   restore, so in that run the later visits to `/?chart=bridge` (overflow.spec.ts's 320
 *   sweep among them) drew the table, not the bridge. That half was an APP defect, and he
 *   could hit it too: since 2026-10-05 a press builds on the page's newest asked view
 *   (src/lib/page-asks.ts). A restore still proves each press, so it never depends on that.
 */

/**
 * Press a segmented-control pill and PROVE the press landed.
 *
 * `gotoHydrated` proves the SHELL has hydrated (the theme toggle is in AppShell). It does
 * not prove the panel has: React hydrates client boundaries independently, so a panel can
 * still be inert when AppShell is live, and a click in that window is swallowed with no
 * error. Measured on zz-zz-view-switcher's portfolio restore step (pass 26): waiting on the
 * shell alone took it from 3-in-5 failures to roughly 2-in-12 — a real improvement, and
 * still a flake. The failure dump was identical every time, `button "Return" [pressed]`,
 * i.e. the handler never ran.
 *
 * There is no DOM signal for "this boundary is now interactive", so instead of guessing a
 * longer wait we retry the press until its own control reports the new state. That is safe
 * precisely BECAUSE it is idempotent: useViewState does nothing for a value already on
 * screen, and a press repeated while the first is still in flight is sent again the same —
 * the same write, the same URL — never a toggle (src/hooks/useViewState.test.ts).
 *
 * This strengthens the action, not the expectation — every caller's assertions about URL,
 * slider and persistence still have to hold on their own.
 */
export async function pressView(page: Page, group: string, name: string): Promise<void> {
  const pill = page.getByRole("group", { name: group }).getByRole("button", { name });
  await expect(async () => {
    await pill.click();
    await expect(pill).toHaveAttribute("aria-pressed", "true", { timeout: 3_000 });
  }).toPass({ timeout: 30_000 });
}

/**
 * How long `delayServerActions` holds each press by default: an order of magnitude past the
 * tens of milliseconds between a bare click and whatever a spec does next, and still cheap
 * for a restore that waits, which pays it once per press.
 */
export const SERVER_ACTION_HOLD_MS = 400;

/**
 * Hold every server action this page sends for `ms` before it reaches the server.
 *
 * The races above lose only when the server is slow, which is why they surfaced once in
 * ~15 gates and never alone. Holding the REQUEST makes "slow" the normal case: until it is
 * released the press has not been written, so whatever a spec does before the press is
 * proved — a `page.goto`, a second press — meets the view as it was before the press, every
 * run instead of one in fifteen. A spec that waits (pressView) only takes `ms` longer.
 *
 * A page that navigates away while a request is held never sends it; that is the outcome
 * this exists to expose, not an error, so a closed route is swallowed.
 *
 * The hold ends by itself when the next DOCUMENT loads — a fresh visit is where every race
 * above ends, and the next page's own actions ("Detect now" in the holding-table test) must
 * not inherit it. Ending it from the caller instead would undo the guard exactly when it is
 * needed: after a bare click, an explicit release can run before the click's request has
 * even been intercepted. A press's own navigation is a soft one (no new document), so it
 * does not end the hold, and neither does the second press of a restore.
 */
export async function delayServerActions(
  page: Page,
  ms: number = SERVER_ACTION_HOLD_MS,
): Promise<void> {
  const everyRequest = (): boolean => true;
  const hold = async (route: Route): Promise<void> => {
    if (!(await isServerAction(route.request()))) {
      await route.fallback();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, ms));
    await route.continue().catch(() => {});
  };
  await page.route(everyRequest, hold);
  page.once("domcontentloaded", () => {
    page.unroute(everyRequest, hold).catch(() => {});
  });
}

/** A press's write: a server action, as Next sends it. */
export async function isServerAction(request: Request): Promise<boolean> {
  return request.method() === "POST" && (await request.headerValue("next-action")) !== null;
}

/**
 * The request a navigation to `pathname` with exactly `params` makes for its page: Next's RSC
 * fetch (`RSC: 1`; its `_rsc` cache key aside), never a link's prefetch.
 */
export function pageRequest(
  pathname: string,
  params: Record<string, string>,
): (request: Request) => Promise<boolean> {
  return async (request) => {
    if (request.method() !== "GET" || (await request.headerValue("rsc")) !== "1") return false;
    if ((await request.headerValue("next-router-prefetch")) !== null) return false;
    const url = new URL(request.url());
    url.searchParams.delete("_rsc");
    return url.pathname === pathname && sortedQuery(url.searchParams) === sortedQuery(Object.entries(params));
  };
}

function sortedQuery(entries: Iterable<[string, string]>): string {
  return [...entries]
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join("&");
}

export interface HeldRequests {
  /** how many requests are held: from the first, what they were for is in flight and stays there */
  count(): number;
  /** sends every held request on, and lets every later one through */
  release(): Promise<void>;
}

/**
 * Hold every request `matches` picks until the spec lets them go — for a race whose ORDER the
 * spec must decide (a link's page drawn before a press's write lands; a range pill's page
 * still in flight when the next press is made), which a fixed delay only makes likely.
 * Wait for `count()` before relying on it: a release can otherwise run before the request it
 * was for has even been intercepted (the reason delayServerActions ends on its own).
 */
export async function holdRequests(
  page: Page,
  matches: (request: Request) => Promise<boolean>,
): Promise<HeldRequests> {
  const everyRequest = (): boolean => true;
  const held: Route[] = [];
  let released = false;
  const hold = async (route: Route): Promise<void> => {
    if (released || !(await matches(route.request())) || released) {
      await route.fallback();
      return;
    }
    held.push(route);
  };
  await page.route(everyRequest, hold);
  return {
    count: () => held.length,
    async release() {
      released = true;
      await page.unroute(everyRequest, hold);
      await Promise.all(held.map((route) => route.continue().catch(() => {})));
    },
  };
}
