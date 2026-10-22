import { Icon } from "@/components/shell/Icon";
import { VERDICT_PRESENTATION, verdictToneClass, type PresentedVerdict } from "@/lib/provenance-verdict";

/**
 * A verdict's chip where its proof cannot be opened: the glyph, the word and the tone `ProvenancePopover`'s trigger
 * wears (`VERDICT_PRESENTATION`, one place for all three), as an annotation and never a control.
 *
 * ⛔ For a figure inside a link — a `StatCard` with an href is one `<a>`, and a `<button>` inside it is axe
 * `nested-interactive` (serious), the trap `ProvenancePopover` documents. The proof itself is opened where the figure's
 * section heading carries it (/spending's "Where it went"). `aria-hidden`: the link's own name says it in words.
 *
 * ⚖️ Decision 72 (2026-10-13): /spending's Spent card over days not every account he spends from is read for wears
 * "partly read", as the period proof on the same page does. 🔴 His ledger copy 2026-10-21: "SPENT $1,603.00" bare over
 * "Where it went · partly read · spending imported through Aug 12 · 21 days of this period unaccounted".
 */
export function VerdictChip({ verdict }: { verdict: PresentedVerdict }) {
  const present = VERDICT_PRESENTATION[verdict];
  return (
    <span
      aria-hidden="true"
      // normal-case/tracking-normal: it sits inside the card's uppercase label, which would otherwise shout it
      className={`ml-1.5 inline-flex translate-y-px items-center gap-1 align-middle text-xs font-normal normal-case leading-none tracking-normal ${verdictToneClass(present.tone)}`}
    >
      <Icon name={present.icon} className="size-3.5" />
      <span className="hidden sm:inline">{present.word}</span>
    </span>
  );
}
