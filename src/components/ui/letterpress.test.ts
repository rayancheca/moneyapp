import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as letterpress from "./letterpress";
import {
  BLANK_LEAF,
  CATCH_LIGHT,
  CATCH_LIGHT_LEFT,
  CONTROL_HOVER,
  CONTROL_MOTION,
  LEAF,
  LIFT_ON_HOVER,
  OVERLAY_PRESS,
  PLATE,
  PRESS,
  PRESSED_SLOT,
  ROW_HOVER,
  RULE_HAIR,
  RULE_STRONG,
  RULE_STRONG_BOTTOM,
  SLUG,
} from "./letterpress";

const UI_DIR = fileURLToPath(new URL(".", import.meta.url));

function source(file: string): string {
  return readFileSync(`${UI_DIR}${file}`, "utf8");
}

/** Source with comments removed, so prose about a hazard is not mistaken for one. */
function codeOnly(file: string): string {
  return source(file)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const RECIPES: Record<string, string> = {
  BLANK_LEAF,
  CATCH_LIGHT,
  CATCH_LIGHT_LEFT,
  CONTROL_HOVER,
  CONTROL_MOTION,
  LEAF,
  LIFT_ON_HOVER,
  OVERLAY_PRESS,
  PLATE,
  PRESSED_SLOT,
  ROW_HOVER,
  RULE_HAIR,
  RULE_STRONG,
  RULE_STRONG_BOTTOM,
  SLUG,
  ...PRESS,
};

describe("depth is ranked, and the ranking is the contract", () => {
  it("offers exactly three steps — rule, card, lifted", () => {
    expect(Object.keys(PRESS)).toEqual(["rule", "card", "lifted"]);
  });

  it("maps each step onto its own press token, in order", () => {
    expect(PRESS.rule).toBe("shadow-press-1");
    expect(PRESS.card).toBe("shadow-press-2");
    expect(PRESS.lifted).toBe("shadow-press-3");
  });

  it("never gives two ranks the same shadow — a tie is a hierarchy that failed", () => {
    expect(new Set(Object.values(PRESS)).size).toBe(3);
  });
});

describe("the press/slot inversion — the whole language in two rules", () => {
  it("lifts a sheet with the catch-light on its lit edge and nothing else", () => {
    expect(CATCH_LIGHT).toContain("--emboss-hi");
    expect(CATCH_LIGHT).not.toContain("--emboss-lo");
    // the md+ drawer enters from the right, so its lit edge is the left one
    expect(CATCH_LIGHT_LEFT).toContain("inset_1px_0_0");
    expect(CATCH_LIGHT).toContain("inset_0_1px_0");
  });

  it("presses a slot with the ink pool and pointedly NO catch-light", () => {
    expect(PRESSED_SLOT).toContain("--emboss-lo");
    expect(PRESSED_SLOT).not.toContain("--emboss-hi");
  });

  it("composes onto a reserved dialog shadow rather than replacing it", () => {
    // globals.css reserves --shadow-overlay for dialog surfaces; a second
    // shadow-* utility would REPLACE it, so the two must ship as one value
    expect(OVERLAY_PRESS).toContain("var(--shadow-overlay)");
    expect(OVERLAY_PRESS).toContain("inset_0_1px_0_var(--emboss-hi)");
  });
});

describe("the sheets of paper", () => {
  it("prints the plate on the raised sheet and the leaf on its own tone", () => {
    expect(PLATE).toContain("bg-surface-raised");
    expect(LEAF).toContain("bg-surface-leaf");
  });

  it("rests both at the card rank — a nested panel is not a second elevation", () => {
    expect(PLATE).toContain(PRESS.card);
    expect(LEAF).toContain(PRESS.card);
  });

  it("tags the slug down its left edge in accent ink", () => {
    expect(SLUG).toContain("border-l-accent-ink");
    expect(SLUG).toContain("bg-surface-leaf");
    expect(SLUG).toContain(PRESS.rule);
  });

  it("sets the strong rule in display ink and the hairline in --line", () => {
    expect(RULE_STRONG).toContain("border-t-2");
    expect(RULE_STRONG).toContain("ink-display");
    expect(RULE_STRONG_BOTTOM).toContain("border-b-2");
    expect(RULE_STRONG_BOTTOM).toContain("ink-display");
    expect(RULE_HAIR).toContain("border-t-line");
  });
});

describe("a control presses INTO the page", () => {
  it("translates down on active — the physical claim the direction rests on", () => {
    expect(CONTROL_MOTION).toContain("active:translate-y-px");
  });

  it("transitions every property it actually animates", () => {
    // opacity is here because the primary button dims rather than warming;
    // translate is here because v4 translate-y-px sets `translate`, not
    // `transform`, and a missing entry silently snaps instead of easing
    for (const property of ["color", "background-color", "border-color", "box-shadow", "opacity", "translate"]) {
      expect(CONTROL_MOTION).toContain(property);
    }
  });

  it("arrives on --ease-ink: money that bounces reads as unsettled", () => {
    expect(CONTROL_MOTION).toContain("ease-(--ease-ink)");
    expect(ROW_HOVER).toContain("ease-(--ease-ink)");
  });

  it("warms to the leaf tone on hover, for both controls and rows", () => {
    expect(CONTROL_HOVER).toContain("hover:bg-surface-leaf");
    expect(ROW_HOVER).toContain("hover:bg-surface-leaf");
  });
});

describe("no raw colour ever leaves this module", () => {
  it.each(Object.entries(RECIPES))(
    "%s names tokens, never literals — that is what keeps the WCAG measurements true",
    (_name, recipe) => {
      expect(recipe).not.toMatch(/#[0-9a-f]{3}/i);
      expect(recipe).not.toMatch(/\b(oklch|rgba?|hsla?)\(/);
    },
  );
});

describe("Tailwind can actually generate these classes", () => {
  // Tailwind v4 extracts candidates from raw source TEXT. A variant assembled
  // at runtime (`hover:${PRESS.card}`) produces a class that exists in the DOM
  // and in no stylesheet — the most expensive kind of silent failure, because
  // it type-checks, renders, and simply does nothing.
  it("never composes a variant prefix onto an interpolation, anywhere in the directory", () => {
    const offenders = readdirSync(UI_DIR)
      .filter((f) => f.endsWith(".tsx") || f.endsWith(".ts"))
      .flatMap((file) =>
        [...codeOnly(file).matchAll(/(hover|focus|active|group-hover|disabled|dark):\$\{/g)].map(
          ([match]) => `${file}: ${match}`,
        ),
      );
    expect(offenders).toEqual([]);
  });

  it("spells the hover lift out in full", () => {
    expect(LIFT_ON_HOVER).toBe("hover:shadow-press-2");
  });

  // Measured against the built stylesheet: Tailwind emits `.shadow-none`
  // BEFORE `.shadow-press-2`, and they have equal specificity — so adding
  // `shadow-none` next to a press class does nothing at all. The flat surface
  // has to be its own recipe, and nobody may "simplify" it back.
  it("expresses a flat surface by omitting depth, never by cancelling it", () => {
    expect(BLANK_LEAF).not.toContain("shadow");
    expect(BLANK_LEAF).toContain("bg-surface-leaf");
  });

  it("never tries to cancel a press with shadow-none anywhere in the directory", () => {
    const offenders = readdirSync(UI_DIR)
      .filter((f) => f.endsWith(".tsx"))
      .filter((file) => {
        const code = codeOnly(file);
        return code.includes("shadow-none") && /shadow-press-|PRESS\.|PLATE|LEAF\b/.test(code);
      });
    expect(offenders).toEqual([]);
  });
});

describe("adoption — the app inherits the look from one file", () => {
  // A token contract nobody consumes is not a design. These are the primitives
  // every page renders through; if one of them stops importing the vocabulary,
  // that page has quietly left the direction.
  const CONSUMERS = [
    "Button.tsx",
    "Confirm.tsx",
    "DataTable.tsx",
    "Field.tsx",
    "Rule.tsx",
    "Skeleton.tsx",
    "StatCard.tsx",
    "SurfaceCard.tsx",
    "Toast.tsx",
    "Tooltip.tsx",
    "ViewSwitcher.tsx",
  ];

  it.each(CONSUMERS)("%s inherits from the shared vocabulary", (file) => {
    expect(source(file)).toMatch(/from "(\.\/|@\/components\/ui\/)letterpress"/);
  });

  it("hard-codes no colour inside any box-shadow in the whole directory", () => {
    const offenders = readdirSync(UI_DIR)
      .filter((f) => f.endsWith(".tsx") || f.endsWith(".css"))
      .flatMap((file) =>
        [...codeOnly(file).matchAll(/shadow-\[[^\]]*\]/g)]
          .filter(([match]) => /#[0-9a-f]{3}|\b(oklch|rgba?|hsla?)\(/i.test(match))
          .map(([match]) => `${file}: ${match}`),
      );
    expect(offenders).toEqual([]);
  });
});

describe("the module stays a vocabulary, not a grab bag", () => {
  it("exports only strings and the one ranked record", () => {
    for (const [name, value] of Object.entries(letterpress)) {
      if (name === "PRESS") {
        expect(typeof value).toBe("object");
        continue;
      }
      expect(typeof value, `${name} should be a class string`).toBe("string");
    }
  });
});
