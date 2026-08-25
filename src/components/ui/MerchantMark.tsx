import { brandMarkFor } from "@/lib/brand-mark";
import { categoryHueVar, type CategoryHueName } from "@/lib/category-palette";

interface MerchantMarkProps {
  /** the merchant or series name, as shown to the reader */
  name: string;
  /** the category hue this charge belongs to; null draws a neutral tile */
  hue: CategoryHueName | null;
  /** tile edge in px — the mark scales with it */
  size?: number;
  /** dim the tile for a charge the app is not standing behind */
  muted?: boolean;
  className?: string;
}

/**
 * A merchant as a TILE: its brand logo where the app has one, its initials
 * where it does not, on its category's colour.
 *
 * ## Two channels, and both of them are information
 *
 * The **hue** is the category — the same 12-hue ramp `/categories` and every
 * chip in the app already use, so an indigo tile means Subscriptions here
 * exactly as it does there. The **glyph** is the merchant. Together they make a
 * charge identifiable without reading a word of it, which is the thing the
 * owner said the calendar could not do: *"i can barely understand it"*.
 *
 * Most tiles will be monograms. The vendored set carries 63 logos against 893
 * merchants, and simple-icons has dropped Amazon, OpenAI, T-Mobile and every US
 * utility over trademark policy — so on this ledger specifically, the monogram
 * IS the design and the logo is a bonus. Both are the same tile at the same
 * size in the same hue; a row of them reads as one system either way.
 *
 * The brand's own colour is deliberately NOT used. Netflix red beside Spotify
 * green beside Uber black would be three unrelated palettes on one page, and it
 * would put brand identity in the channel this app spends on category identity.
 * The logo is drawn in the category's ink instead.
 */
export function MerchantMark({ name, hue, size = 18, muted = false, className }: MerchantMarkProps) {
  const mark = brandMarkFor(name);
  const solid = hue ? categoryHueVar(hue, "solid") : "var(--ink-faint)";
  const soft = hue ? categoryHueVar(hue, "soft") : "var(--surface-sunken)";

  return (
    <span
      aria-hidden
      className={`inline-flex shrink-0 items-center justify-center rounded-[5px] ring-1 transition-transform duration-(--duration-fast) ease-(--ease-out-expo) ${
        muted ? "opacity-55" : ""
      } ${className ?? ""}`.trim()}
      style={{
        width: size,
        height: size,
        // The soft tint is the AA-verified chip background from the category
        // ramp; the solid is its ≥3:1 partner, used here for both the ring and
        // the glyph so the tile holds together at 14px.
        backgroundColor: soft,
        color: solid,
        // `ring-1` needs its colour from somewhere continuous — the hue is not a
        // finite class set.
        ["--tw-ring-color" as string]: `color-mix(in oklab, ${solid} 28%, transparent)`,
      }}
    >
      {mark.kind === "logo" && mark.icon ? (
        <svg
          viewBox="0 0 24 24"
          width={Math.round(size * 0.62)}
          height={Math.round(size * 0.62)}
          fill="currentColor"
          role="img"
        >
          <path d={mark.icon.path} />
        </svg>
      ) : (
        <span
          className="font-semibold leading-none"
          // Two letters have to fit inside a 14–20px tile, which no type scale
          // step lands on; it is derived from the tile instead so the mark stays
          // optically constant as the grid grows.
          style={{ fontSize: Math.max(7, Math.round(size * 0.42)) }}
        >
          {mark.monogram}
        </span>
      )}
    </span>
  );
}
