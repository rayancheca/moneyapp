"use client";

import type { ReactNode } from "react";
import { Icon } from "@/components/shell/Icon";
import type { Placement } from "@/lib/positioning";
import { Tooltip } from "./Tooltip";

interface InfoTipProps {
  /**
   * The on-screen term this explains, verbatim. It becomes part of the
   * trigger's accessible name and is never rendered as visible text, so axe's
   * label-content-name-mismatch cannot fire on a control whose only visible
   * content is an icon.
   */
  term: string;
  /**
   * One definitional sentence.
   *
   * ⛔ No figures, and no phrase the surrounding page already owns. A tooltip
   * body is LIVE DOM TEXT even while closed — measured: Playwright's text engine
   * ignores visibility, so `getByText(...)` matches it and `toHaveCount` counts
   * it. Copy that repeats a graded phrase breaks an unrelated page-level
   * assertion, and a figure nobody measured breaks the house rule outright.
   * See `JARGON` in `@/lib/jargon` for the vetted set.
   */
  children: ReactNode;
  placement?: Placement;
}

/**
 * A focusable "what does this mean" affordance for one jargon term.
 *
 * The trigger is a <button> rather than a <span> for two measured reasons: a
 * bare span never enters the tab order, so `Tooltip`'s focus handler (gated on
 * :focus-visible) could never fire and the tooltip would be mouse-only; and an
 * icon-only control with no accessible name is an axe `button-name` CRITICAL,
 * which the gated a11y sweep covers on both routes this ships to.
 *
 * ⛔ Never mount inside another interactive element — that is axe
 * `nested-interactive` (serious). Annotate the label beside a control, never
 * inside the control itself.
 */
export function InfoTip({ term, children, placement = "top" }: InfoTipProps) {
  return (
    <Tooltip<HTMLButtonElement> content={children} placement={placement}>
      {(trigger) => (
        <button
          type="button"
          {...trigger}
          aria-label={`What ${term} means`}
          className="ml-1 inline-flex translate-y-px items-center rounded-full p-0.5 align-middle text-ink-faint transition-colors duration-(--duration-fast) hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <Icon name="info" className="size-3" />
        </button>
      )}
    </Tooltip>
  );
}
