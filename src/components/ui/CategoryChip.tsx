import { Icon, isIconName, type IconName } from "@/components/shell/Icon";
import { categoryHueVar, isCategoryHueName } from "@/lib/category-palette";

interface CategoryChipProps {
  label: string;
  /** raw db value (categories.color) — validated here, junk degrades to neutral */
  hue: string | null;
  /** raw db value (categories.icon) — validated here, junk degrades to "tag" */
  icon: string | null;
  /** icon-only rendering for dense contexts; label stays for screen readers */
  compact?: boolean;
  className?: string;
}

/**
 * The category identity token: icon + hue tint, identical everywhere a
 * category appears (rows, sheets, donut legends, calendar dots). Chip text is
 * always --ink on the -soft tint; the hue lives only in icon and border —
 * that is what keeps all 12 hues WCAG-AA in both themes (enforced by the
 * category-palette gate test). Uncategorized (hue null) renders gray + italic.
 */
export function CategoryChip({ label, hue, icon, compact = false, className }: CategoryChipProps) {
  const validHue = isCategoryHueName(hue) ? hue : null;
  const glyph: IconName = isIconName(icon) ? icon : "tag";

  return (
    <span
      style={
        validHue
          ? {
              backgroundColor: categoryHueVar(validHue, "soft"),
              borderColor: `color-mix(in oklch, ${categoryHueVar(validHue)} 30%, transparent)`,
            }
          : undefined
      }
      className={`inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${
        validHue ? "text-ink" : "border-line bg-surface-sunken italic text-ink-faint"
      } ${className ?? ""}`}
    >
      <span
        aria-hidden
        className="inline-flex shrink-0"
        style={validHue ? { color: categoryHueVar(validHue) } : undefined}
      >
        <Icon name={glyph} className="size-3.5" />
      </span>
      <span className={compact ? "sr-only" : "truncate"}>{label}</span>
    </span>
  );
}
