"use client";

import { useEffect, useRef } from "react";
import { Icon } from "@/components/shell/Icon";
import { Popover, usePopover } from "@/components/ui/Popover";
import { VERDICT_PRESENTATION, verdictToneClass, type PresentedVerdict } from "@/lib/provenance-verdict";
import type { Provenance } from "@/services/provenance";

interface ProvenancePopoverProps {
  /** the figure this sits beside, verbatim — becomes part of the accessible name */
  label: string;
  provenance: Provenance;
  /** side to open on; the util flips and clamps if there is no room */
  placement?: "bottom-start" | "bottom-end" | "top-start" | "top-end";
}

/**
 * "Prove it" for one rendered figure: a verdict badge that opens the chain
 * behind the number — which document, which arbiter, what the day's basis is,
 * and how far it is checked.
 *
 * ## Why a Popover and not a Tooltip
 *
 * `InfoTip` forbids figures in its body, and the reason is mechanical rather
 * than stylistic: a Tooltip's content is LIVE DOM even while closed, so
 * Playwright's text engine matches it and a figure inside one breaks unrelated
 * page-level assertions. `Popover` gates its children on `open` and mounts
 * nothing until then, so this panel can name amounts, files and dates — which
 * is the entire point of it.
 *
 * ## Why a sibling and never a wrapper
 *
 * ⛔ It renders BESIDE the figure, never around it. Wrapping would put a
 * `<button>` inside whatever the figure already lives in — a table row's link,
 * an account card — which is axe `nested-interactive` (serious), the same trap
 * `InfoTip` documents. The badge is an annotation on the number, not a new way
 * to click it.
 *
 * ## ⛔ …and NEVER inside a `<p>`
 *
 * The panel below is a sibling of the trigger and it is a `<div popover>`,
 * which a paragraph may not contain. HTML parsing CLOSES the `<p>` where the
 * div begins, so the browser's DOM stops matching the server's string and React
 * throws hydration error #418 — which does not merely warn, it discards the
 * client tree for that subtree and takes its interactivity with it. Mounted in
 * one headline `<p>` on the dashboard it failed eight chart-view tests and the
 * net-worth drag test, none of which name this card.
 *
 * Use a `<div>` (or any flow container) for a headline that carries this badge.
 * `<h1>`…`<h3>`, `<dt>`, `<li>` and `<span>` are all fine — a `<p>` is the one
 * that auto-closes, and therefore the one that breaks.
 *
 * ## The badge has to be legible before it is opened
 *
 * A reader should be able to scan a page and see which figures are standing on
 * something. So the glyph and its tone carry the verdict on their own, and the
 * word appears too wherever there is room. The weak verdicts get the loud
 * treatment and the proven ones stay quiet — a badge that shouts on every
 * figure is a badge nobody reads.
 */
export function ProvenancePopover({ label, provenance, placement = "bottom-start" }: ProvenancePopoverProps) {
  const { anchorRef, open, close, triggerProps } = usePopover<HTMLButtonElement>();
  const panelRef = useRef<HTMLDivElement>(null);
  const present = VERDICT_PRESENTATION[provenance.verdict as PresentedVerdict];

  // move the caret into the panel on open so a keyboard reader lands on the
  // answer rather than being left on the trigger with the panel open behind
  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);

  return (
    <>
      <button
        type="button"
        {...triggerProps}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`How ${label} is proven — ${provenance.badgeWord ? provenance.badgeWord : `it ${present.ariaSuffix}`}`}
        /**
         * ⛔ `-my-0.5 py-0.5` — the negative margin cancels the padding's
         * contribution to the LINE BOX while keeping the hover target's
         * breathing room. Measured: with plain `py-0.5` the badge's box is 20px
         * inside a 16px `text-xs` heading, which grew every page it sits on by
         * 4px and pushed 60,638 pixels of dashboard down. An annotation on a
         * figure must not move the figure.
         */
        className={`ml-1.5 -my-0.5 inline-flex translate-y-px items-center gap-1 rounded-full px-1 py-0.5 align-middle text-xs leading-none transition-colors duration-(--duration-fast) hover:bg-surface-sunken focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${verdictToneClass(present.tone)}`}
      >
        <Icon name={present.icon} className="size-3.5" />
        <span className="hidden sm:inline">{provenance.badgeWord ?? present.word}</span>
      </button>
      <Popover anchorRef={anchorRef} open={open} onClose={close} placement={placement} offset={6} className="w-80 max-w-[min(20rem,calc(100vw-24px))]">
        <div
          ref={panelRef}
          tabIndex={-1}
          role="dialog"
          aria-label={`What ${label} is standing on`}
          /**
           * ⛔ `normal-case tracking-normal font-normal` is LOAD-BEARING, not
           * tidiness. `Popover` renders its panel as a SIBLING where the
           * component is mounted, and this badge is mounted inside whatever
           * labels the figure — on the dashboard that is
           * `<h1 class="uppercase tracking-[0.14em]">`. Inherited, the whole
           * panel rendered in shouty caps: "39 ROWS BUT NO RECORDED BALANCE".
           * Caught by screenshotting it, not by tsc or by any assertion.
           */
          className="space-y-3 p-3.5 text-sm font-normal normal-case tracking-normal outline-none"
        >
          <p className={`flex items-center gap-1.5 text-xs font-medium uppercase tracking-[0.1em] ${verdictToneClass(present.tone)}`}>
            <Icon name={present.icon} className="size-3.5" />
            {provenance.badgeWord ?? present.word}
          </p>

          <p className="text-[13px] leading-relaxed text-ink-muted">{provenance.headline}</p>

          {provenance.checkedThrough && (
            <p className="text-[13px] text-ink-faint">
              Checked through <span className="figures text-ink">{provenance.checkedThrough}</span>.
            </p>
          )}

          {provenance.sources.length > 0 && (
            <div className="space-y-1.5 border-t border-line pt-3">
              <p className="text-xs font-medium uppercase tracking-[0.1em] text-ink-faint">Standing on</p>
              <ul className="space-y-1.5">
                {provenance.sources.map((source, i) => (
                  <li key={`${source.kind}-${source.label}-${i}`} className="text-[13px] leading-snug">
                    <span className="break-all text-ink">{source.label}</span>
                    {source.detail && <span className="text-ink-faint"> — {source.detail}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {provenance.inputs.length > 0 && (
            <div className="space-y-1.5 border-t border-line pt-3">
              <p className="text-xs font-medium uppercase tracking-[0.1em] text-ink-faint">
                Assembled from {provenance.inputs.length}
              </p>
              {/* a dozen accounts is normal here, so the list scrolls rather
                  than pushing the panel past the viewport */}
              <ul className="max-h-56 space-y-1 overflow-y-auto pr-1">
                {provenance.inputs.map((input) => {
                  const p = VERDICT_PRESENTATION[input.verdict as PresentedVerdict];
                  return (
                    <li key={input.label} className="text-[13px] leading-snug">
                      {/* one FLOWING line, not two flex columns: a long account
                          name beside a long detail produced ragged two-line
                          columns that were hard to read down. The glyph is
                          inline so the text wraps under itself as a sentence. */}
                      <Icon
                        name={p.icon}
                        className={`mr-1.5 inline size-3 shrink-0 -translate-y-px ${verdictToneClass(p.tone)}`}
                      />
                      <span className="text-ink">{input.label}</span>
                      {input.detail && <span className="text-ink-faint"> — {input.detail}</span>}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      </Popover>
    </>
  );
}
