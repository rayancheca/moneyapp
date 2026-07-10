import type { Oklch } from "./color-contrast";

/**
 * Source of truth for the 12-hue category identity ramp. globals.css mirrors
 * these values by hand (Tailwind v4 is CSS-first); the palette test parses the
 * CSS and fails on any drift, then proves the contrast contract:
 *   - chip text is always --ink on the -soft tint (≥ 4.5:1, WCAG AA text)
 *   - solids carry icons/borders/dots on any surface (≥ 3:1, graphical objects)
 */

export const CATEGORY_HUE_NAMES = [
  "red",
  "orange",
  "amber",
  "lime",
  "green",
  "teal",
  "cyan",
  "blue",
  "indigo",
  "violet",
  "pink",
  "brown",
] as const;

export type CategoryHueName = (typeof CATEGORY_HUE_NAMES)[number];

export interface HueTheme {
  solid: Oklch;
  soft: Oklch;
}

export interface CategoryHue {
  light: HueTheme;
  dark: HueTheme;
}

function hue(
  lightSolid: [number, number, number],
  lightSoft: [number, number, number],
  darkSolid: [number, number, number],
  darkSoft: [number, number, number],
): CategoryHue {
  const toOklch = ([l, c, h]: [number, number, number]): Oklch => ({ l, c, h });
  return {
    light: { solid: toOklch(lightSolid), soft: toOklch(lightSoft) },
    dark: { solid: toOklch(darkSolid), soft: toOklch(darkSoft) },
  };
}

export const CATEGORY_PALETTE: Record<CategoryHueName, CategoryHue> = {
  red: hue([0.53, 0.13, 25], [0.94, 0.028, 25], [0.72, 0.13, 25], [0.3, 0.05, 25]),
  orange: hue([0.52, 0.11, 55], [0.94, 0.03, 55], [0.73, 0.12, 55], [0.3, 0.05, 55]),
  amber: hue([0.5, 0.1, 80], [0.945, 0.035, 80], [0.75, 0.12, 80], [0.3, 0.05, 80]),
  lime: hue([0.5, 0.1, 120], [0.945, 0.035, 120], [0.74, 0.12, 120], [0.3, 0.05, 120]),
  green: hue([0.5, 0.1, 155], [0.94, 0.03, 155], [0.73, 0.11, 155], [0.3, 0.045, 155]),
  teal: hue([0.5, 0.08, 185], [0.94, 0.028, 185], [0.73, 0.1, 185], [0.3, 0.045, 185]),
  cyan: hue([0.51, 0.09, 215], [0.94, 0.028, 215], [0.73, 0.1, 215], [0.3, 0.045, 215]),
  blue: hue([0.52, 0.1, 245], [0.94, 0.028, 245], [0.72, 0.1, 245], [0.3, 0.045, 245]),
  indigo: hue([0.52, 0.1, 275], [0.938, 0.028, 275], [0.72, 0.1, 275], [0.3, 0.045, 275]),
  violet: hue([0.52, 0.11, 300], [0.938, 0.028, 300], [0.72, 0.11, 300], [0.3, 0.048, 300]),
  pink: hue([0.53, 0.12, 345], [0.94, 0.028, 345], [0.73, 0.12, 345], [0.3, 0.05, 345]),
  brown: hue([0.5, 0.06, 60], [0.94, 0.02, 60], [0.72, 0.07, 60], [0.3, 0.03, 60]),
};

export function isCategoryHueName(value: string | null | undefined): value is CategoryHueName {
  return typeof value === "string" && (CATEGORY_HUE_NAMES as readonly string[]).includes(value);
}

/** CSS custom-property reference for a hue, e.g. `var(--cat-green-soft)`. */
export function categoryHueVar(name: CategoryHueName, variant: "solid" | "soft" = "solid"): string {
  return variant === "soft" ? `var(--cat-${name}-soft)` : `var(--cat-${name})`;
}
