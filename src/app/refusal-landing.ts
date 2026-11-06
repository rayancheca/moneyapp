import { redirect } from "next/navigation";
import type { ActionResult } from "@/app/transactions/action-types";
import { REFUSAL_SHOWN } from "@/components/ui/ErrorBanner";

/** Where a form's press goes besides back to its own page — each optional (`landBack`). */
export interface Landing<T> {
  /** where a refusal is said when that is another page: a balance removed or an account archived on /accounts/[id] */
  readonly refusedOn?: string;
  /**
   * Where a press that lands goes, for a form that leaves its page on every press: /budgets after a budget is created
   * or deactivated, the filtered view /transactions' header strip was pressed from (a notice on it when there is one),
   * a new account's page. Without it a press that lands stays where it is.
   */
  readonly landsOn?: (data: T) => string;
}

/** `page?error=…` — or `&error=…` after a query of the page's own, as /transactions' filtered view has */
function refusalUrl(page: string, error: string): string {
  return `${page}${page.includes("?") ? "&" : "?"}error=${encodeURIComponent(error)}`;
}

/**
 * Where a `<form action>` adapter lands — ONE rule for every one of them (/imports, /settings, /accounts and
 * /accounts/[id], /investments, /recurring, /budgets, /transactions; refusal-landing.test.ts reads every adapter and
 * every form that binds one): a refusal on `?error=` (the /budgets pattern); a press that lands stays where it is — but
 * where the page shows a refusal (its form carries `REFUSAL_SHOWN`), back on `page` with none. A form that leaves its
 * page on every press goes where its press lands (`landsOn`), as it always did. ⚖️ Owner 2026-10-06 (§6A 44): a view
 * press on /recurring clears a stale `?error=` banner, as the tabs do — carried here to every form. `refusedOn` is
 * where the refusal is said when that is another page: a balance removed or an account archived on /accounts/[id] is
 * refused on /accounts.
 *
 * ⚠️ Forms only. A press that returns a value — a run (`useAction`), an Undo card, an inline edit — moves no URL, and
 * the banner it lands beside stays until a form press, a view press or a navigation takes it away: on /settings under
 * `?error=…`, "Back up now" landed (a restore point listed) and the refusal stayed above it (the review of b96b7546,
 * 2026-11-05). §6A 44 as recorded speaks of view presses; whether those presses clear it too is his call — ⏳ asked.
 *
 * 🔴 425ae02c built this for /imports alone, and the review of it measured the rest unchanged (2026-11-05, a dev server
 * over his ledger copy 10-29b): on /settings a cleared "Price staleness (hours)" refused to `?error=Price staleness
 * window: Too small: expected number to be >=1`, the next Save landed (4 → 6), and the banner stayed beside the saved
 * 6 — each adapter returned on a success, and the page re-rendered under the URL the refusal had left.
 * Not a redirect after every press where a page had none: it scrolled /imports to its top (1,200px to 0, 2026-11-05).
 *
 * A press made while a refusal shows REPLACES the refusal's entry in his history — with the page, the page it goes to,
 * or the next refusal; a first refusal is pushed, so Back from it is the page as it stood. 🔴 In a server action
 * `redirect()` pushes unless told otherwise (next/dist/client/components/redirect.js), and the review of b96b7546
 * measured it (2026-11-05, a dev server over the copy 10-29b): the refusal 7 → 8, the Save of 6 that landed 8 → 9 — and
 * one Back ran GET `/settings?error=…`, the refusal back above the 6 he had saved. Re-measured with this (same copy,
 * same day): the refusal 2 → 3, the Save of 6 landed in its place (3), and Back was /settings with no alert.
 *
 * 🔴 …and it reached only the forms that stay on their page, not /budgets', the page it names as its origin: the
 * review of cb2e89ac (2026-11-05, the copy 10-29b) created Housing, Annual, 0 → `/budgets?error=Budget amount must be
 * positive` (history 3 → 4), 12.34 landed on /budgets (4 → 5), and one Back brought the alert back above the budget
 * he had just created. /transactions' header strip and a new account left the same way. Re-measured on a dev server
 * over his ledger copy 2026-11-06 (10-29b, today Nov 6): before, the refusal 6 → 7, 12.34 landed 7 → 8, and Back was
 * the alert above the $12.34 plan; with every form adapter landing here, the refusal 13 → 14, 12.34 landed in its
 * place (14), and Back was /budgets with no alert and the $12.34 plan listed.
 * ⛔ redirect() throws NEXT_REDIRECT by design — it must stay outside any catch.
 */
export function landBack<T>(
  page: string,
  formData: FormData,
  result: ActionResult<T>,
  { refusedOn = page, landsOn }: Landing<T> = {},
): void {
  const entry = formData.get(REFUSAL_SHOWN) !== null ? "replace" : "push";
  if (!result.ok) redirect(refusalUrl(refusedOn, result.error), entry);
  else if (landsOn !== undefined) redirect(landsOn(result.data), entry);
  else if (entry === "replace") redirect(page, entry);
}
