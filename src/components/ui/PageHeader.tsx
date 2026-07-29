import { Rule } from "./Rule";

interface PageHeaderProps {
  title: string;
  description?: string;
  /**
   * The small-caps kicker set above the title, the way a section is labelled
   * in print ("SPENDING", "THE YEAR SO FAR"). Optional and additive — every
   * existing call site keeps exactly the header it had, plus the rules.
   */
  eyebrow?: string;
  /** trailing controls set on the title's baseline (filters, view switchers) */
  actions?: React.ReactNode;
}

/**
 * The page masthead. The title is set in --ink-display and closed by the
 * masthead rule pair — 2px of ink over a hairline — which is what makes each
 * page open like a printed sheet instead of like a route.
 */
export function PageHeader({ title, description, eyebrow, actions }: PageHeaderProps) {
  return (
    <header className="mb-8">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <div className="min-w-0">
          {eyebrow ? (
            <span className="block text-[11px] font-semibold uppercase tracking-[0.14em] text-annotation">
              {eyebrow}
            </span>
          ) : null}
          <h1 className="text-2xl font-semibold tracking-tight text-ink-display">{title}</h1>
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {description ? (
        <p className="mt-1.5 max-w-prose text-sm text-ink-muted">{description}</p>
      ) : null}
      <Rule weight="masthead" className="mt-3" />
    </header>
  );
}
