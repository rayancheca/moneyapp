import Link from "next/link";
import type { TxnNotice } from "./query";

const NOTICE_COPY: Record<TxnNotice, { title: string; body: string }> = {
  "direction-guard": {
    title: "Merchant mapping left unchanged",
    body:
      "This transaction's sign opposes the merchant's usual direction (a refund or reversal), so the category change was applied to this transaction only. Refund protection keeps one credit from flipping the merchant's default mapping.",
  },
  "no-api-key": {
    title: "ANTHROPIC_API_KEY is missing",
    body:
      "Claude classification didn't run. Add the key to .env.local and try again — the merchants stay queued and nothing is lost. Everything else works without it.",
  },
};

interface NoticeBannerProps {
  notice: TxnNotice;
  /** the same view without the notice param */
  dismissHref: string;
}

/** Dismissible one-shot notice driven by ?notice= — dismissing clears the param. */
export function NoticeBanner({ notice, dismissHref }: NoticeBannerProps) {
  const copy = NOTICE_COPY[notice];
  return (
    <div
      role="status"
      className="mb-6 flex items-start justify-between gap-4 rounded-(--radius-card) border border-warning bg-surface-raised p-4"
    >
      <div>
        <p className="text-sm font-medium">
          <span aria-hidden className="mr-2 inline-block size-1.5 rounded-full bg-warning align-middle" />
          {copy.title}
        </p>
        <p className="mt-1 max-w-prose text-sm leading-relaxed text-ink-muted">{copy.body}</p>
      </div>
      <Link
        href={dismissHref}
        className="shrink-0 rounded-md border border-line px-2.5 py-1 text-xs font-medium text-ink-muted transition-colors duration-(--duration-fast) hover:border-line-strong hover:text-ink"
      >
        Dismiss
      </Link>
    </div>
  );
}
