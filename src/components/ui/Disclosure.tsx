"use client";

import { useId, useState, type ReactNode } from "react";

/**
 * Expand-in-place disclosure, extracted from the idiom `InstitutionCard` has
 * shipped since the accounts rebuild (`InstitutionCard.tsx:90-158`) rather than
 * invented: a `grid-rows-[0fr]→[1fr]` transition on an ALWAYS-RENDERED region.
 *
 * Two things about that shape are load-bearing and easy to lose:
 * - The region stays mounted, so `grid-template-rows` can animate at all and the
 *   panel's own content does not re-fetch or re-mount on every toggle.
 * - `inert` (not `hidden`, not conditional rendering) is what removes the
 *   collapsed content from the tab order AND the accessibility tree. Without it
 *   a closed panel is a keyboard trap of invisible controls, which is exactly
 *   the class of defect the /categories route now gets swept for by axe.
 *
 * `prefers-reduced-motion` needs no handling here — globals.css neutralises
 * transition durations globally, so the panel simply snaps.
 */
export interface DisclosureProps {
  /** the always-visible row; receives the props that make it a valid trigger */
  summary: (props: DisclosureTriggerProps) => ReactNode;
  /**
   * The panel, as a function of `open`. A function rather than a node so a caller
   * can keep expensive children out of the tree until they are wanted: this
   * component is used ~77 times on /categories, and mounting every row's menus
   * eagerly costs real DOM and hydration work for panels nobody has opened.
   */
  children: (open: boolean) => ReactNode;
  /** start expanded (a row the caller knows the user is acting on) */
  defaultOpen?: boolean;
  className?: string;
  /** classes for the revealed region's inner padding box */
  panelClassName?: string;
}

export interface DisclosureTriggerProps {
  open: boolean;
  toggle: () => void;
  "aria-expanded": boolean;
  "aria-controls": string;
}

export function Disclosure({
  summary,
  children,
  defaultOpen = false,
  className,
  panelClassName,
}: DisclosureProps) {
  const [open, setOpen] = useState(defaultOpen);
  const regionId = useId();

  return (
    <div className={className}>
      {summary({
        open,
        toggle: () => setOpen((v) => !v),
        "aria-expanded": open,
        "aria-controls": regionId,
      })}
      <div
        id={regionId}
        className={`grid transition-[grid-template-rows] duration-(--duration-normal) ease-(--ease-out-expo) ${
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        }`}
      >
        <div className="overflow-hidden" inert={!open ? true : undefined}>
          <div
            className={`transition-[opacity,transform] duration-(--duration-normal) ease-(--ease-out-expo) ${
              open ? "translate-y-0 opacity-100" : "-translate-y-1 opacity-0"
            } ${panelClassName ?? ""}`}
          >
            {children(open)}
          </div>
        </div>
      </div>
    </div>
  );
}

/** The rotating chevron every disclosure trigger in the app uses. */
export function DisclosureChevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={16}
      height={16}
      aria-hidden="true"
      className={`shrink-0 text-ink-faint transition-transform duration-(--duration-normal) ${
        open ? "rotate-180" : ""
      }`}
    >
      <path
        d="M4 6l4 4 4-4"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
