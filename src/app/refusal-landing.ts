import { redirect } from "next/navigation";
import type { ActionResult } from "@/app/transactions/action-types";
import { REFUSAL_SHOWN } from "@/components/ui/ErrorBanner";

/**
 * Where a `<form action>` adapter lands when its press stays on its page — ONE rule for every one of them (/imports,
 * /settings, /accounts/[id], /investments, /recurring; refusal-landing.test.ts reads every adapter and every form that
 * binds one): a refusal on `?error=` (the /budgets pattern); a press that lands stays where it is — but where the page
 * shows a refusal (its form carries `REFUSAL_SHOWN`), back on `page` with none. ⚖️ Owner 2026-10-06 (§6A 44): a press
 * clears a stale banner. `refusedOn` is where the refusal is said when that is another page: a balance removed or an
 * account archived on /accounts/[id] is refused on /accounts.
 *
 * 🔴 425ae02c built this for /imports alone, and the review of it measured the rest unchanged (2026-11-05, a dev server
 * over his ledger copy 10-29b): on /settings a cleared "Price staleness (hours)" refused to `?error=Price staleness
 * window: Too small: expected number to be >=1`, the next Save landed (4 → 6), and the banner stayed beside the saved
 * 6 — each adapter returned on a success, and the page re-rendered under the URL the refusal had left.
 * Not a redirect after every press, as /budgets does: it scrolled /imports to its top (1,200px to 0, 2026-11-05).
 * ⛔ redirect() throws NEXT_REDIRECT by design — it must stay outside any catch.
 */
export function landBack(
  page: string,
  formData: FormData,
  result: ActionResult<unknown>,
  refusedOn: string = page,
): void {
  if (!result.ok) redirect(`${refusedOn}?error=${encodeURIComponent(result.error)}`);
  if (formData.get(REFUSAL_SHOWN) !== null) redirect(page);
}
