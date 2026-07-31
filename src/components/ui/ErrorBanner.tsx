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
