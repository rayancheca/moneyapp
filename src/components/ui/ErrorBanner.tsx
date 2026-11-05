/**
 * The `?error=` banner every page shows when a server action refuses.
 *
 * Server actions used as `<form action>` cannot return a value — React types the
 * prop as `(formData) => void | Promise<void>` — so the void adapters redirect
 * back with the human message on `?error=` rather than throwing and letting a
 * Next.js error digest replace the page. That contract only holds if the landing
 * page RENDERS the param, and six pages had each hand-rolled byte-identical
 * markup to do it. Two more (`/accounts/[id]` and `/transactions`) were being
 * redirected to and silently dropped it on the floor — the failure mode this
 * component exists to make hard to repeat.
 *
 * `role="alert"` is the point, not decoration: the redirect is a client
 * navigation, so without it a screen-reader user gets a page that looks
 * unchanged and is never told the save was refused.
 *
 * Render it in EVERY return branch of a page, including empty states — an early
 * return that skips it is the partial version of the same bug.
 */
export function ErrorBanner({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="mb-6 rounded-(--radius-card) border border-negative/40 bg-surface-raised px-4 py-3 text-sm text-negative"
    >
      {message}
    </div>
  );
}

/** Narrow a `searchParams` bag's `error` key to a renderable string. */
export function errorParam(raw: Record<string, string | string[] | undefined>): string | null {
  return typeof raw.error === "string" && raw.error !== "" ? raw.error : null;
}

/**
 * The hidden field a form carries while its page shows a refusal: its action, landing, goes back to the page with no
 * `?error=` — and only then, since a redirect after every press would scroll the page to its top (measured on /imports,
 * 2026-11-05: from 1,200px down to 0). 🔴 Without it a refusal's banner outlived the next press that landed: the
 * page re-rendered under the URL the refusal had left (`landBack`, the one rule for every form whose press stays on its
 * page; refusal-landing.test.ts holds every one of them to carrying this).
 */
export const REFUSAL_SHOWN = "refusalShown";

/** The hidden fields a form on a page showing `error` carries — `REFUSAL_SHOWN`, or none. */
export function refusalShownFields(error: string | null): Readonly<Record<string, string>> {
  return error === null ? {} : { [REFUSAL_SHOWN]: "1" };
}

/** Those fields as inputs, for a `<form>` written out by hand (a component handed `fields` spreads them instead). */
export function RefusalShownField({ error }: { error: string | null }) {
  return (
    <>
      {Object.entries(refusalShownFields(error)).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
    </>
  );
}
