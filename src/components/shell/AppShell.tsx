import { CommandPalette, type CommandPaletteGroup } from "@/components/ui/CommandPalette";
import { KeyScopeProvider } from "@/components/ui/KeyScopeProvider";
import { ToastHost } from "@/components/ui/Toast";
import { ToastMnemonic } from "@/components/ui/ToastMnemonic";
import { NAV_ITEMS } from "./nav-items";
import { SideNav } from "./SideNav";
import { MobileNav } from "./MobileNav";
import { ThemeToggle } from "./ThemeToggle";

interface AppShellProps {
  children: React.ReactNode;
  /** Unreviewed active transactions — badges the Transactions nav item. */
  reviewCount: number;
  /** ⌘K entity index (accounts, categories, merchants) — §3.8. */
  entityGroups: CommandPaletteGroup[];
}

const PAGES_GROUP: CommandPaletteGroup = {
  label: "Pages",
  items: NAV_ITEMS.map((item) => ({
    id: `page-${item.href}`,
    label: item.label,
    icon: item.icon,
    href: item.href,
  })),
};

/**
 * THE SHEET — the width the app is set on.
 *
 * Direction A+ (docs/design-directions/direction-A-plus.html, `.page`) states
 * the law in its own comment: "The sheet widens in steps rather than
 * stretching. A measure that runs past a reader's eye span is not 'using the
 * room' — but 650px of dead margin on a 2,560px monitor is not using it
 * either." So it holds 1440px until 1600, then steps 1560 · 1760 · 1960 ·
 * 2140 · 2280. Stepping (rather than a fluid clamp) is deliberate: every
 * section inside gets a STABLE width to compose against instead of reflowing
 * on every pixel of drag.
 *
 * Here the 13.5rem rail is PART of the sheet, so each step below is A+'s page
 * width MINUS 216px — rail + main then totals exactly what A+ lays out at that
 * viewport. AppShell.test.ts re-derives the ladder from this class string and
 * from the mockup's own `.page` rules and proves the arithmetic, so the app
 * cannot silently drift from the approved design.
 *
 * The old fixed `max-w-5xl` left 653px of void per side on the owner's 2545px
 * monitor (measured); the top step leaves 140px and spends the rest on
 * information.
 *
 * These MUST stay whole literal class names. Tailwind scans source text, so
 * composing them (`max-w-[${x}rem]`) or deriving them from a table would emit
 * no CSS at all and silently collapse the sheet back to its intrinsic width.
 */
const SHEET = [
  "mx-auto w-full",
  "max-w-[76.5rem]", // 1224px = 1440 − 216 rail
  "min-[1600px]:max-w-[84rem]", // 1344px = 1560 − 216
  "min-[1800px]:max-w-[96.5rem]", // 1544px = 1760 − 216
  "min-[2000px]:max-w-[109rem]", // 1744px = 1960 − 216
  "min-[2200px]:max-w-[120.25rem]", // 1924px = 2140 − 216
  "min-[2400px]:max-w-[129rem]", // 2064px = 2280 − 216
].join(" ");
/**
 * A+'s `--gutter` is clamp(1.125rem, 0.6rem + 2.2vw, 3rem) — it reaches its
 * 3rem ceiling around 1745px. The shell keeps its existing 1rem/2rem rhythm
 * and adds the final 3rem step at the same place A+ tops out.
 *
 * `min-[768px]:` rather than the equivalent `md:` ON PURPOSE, and measured:
 * Tailwind v4 emits every arbitrary `min-[…px]` rule BEFORE the named
 * breakpoints, so `md:px-8` (emitted later, same specificity) beat
 * `min-[1800px]:px-12` and the wide gutter silently never applied. Ordering
 * only behaves within one variant family — so the whole ladder uses one.
 */
const GUTTER = "px-4 min-[768px]:px-8 min-[1800px]:px-12";

/**
 * THE WORDMARK — A+'s `.wordmark`, `Money<em>App</em>`.
 *
 * Set in the display serif, uppercase and widely tracked, with the second half
 * italic in --accent-ink. Two things this is careful about: the DOM text stays
 * the single string "MoneyApp" (the casing is a CSS transform and the `<em>` is
 * a child, so `textContent`, the accessible name and any text query are all
 * unchanged), and the `<em>` is decorative emphasis rather than semantic stress
 * — but `<em>` is what A+ uses and it costs nothing at 8 characters.
 *
 * Rendered twice: in the rail on md+, in the masthead below it.
 */
function Wordmark() {
  return (
    <span className="font-display text-h3 font-semibold tracking-[0.09em] text-ink-display uppercase">
      Money
      <em className="tracking-[0.02em] text-accent-ink">App</em>
    </span>
  );
}

export function AppShell({ children, reviewCount, entityGroups }: AppShellProps) {
  return (
    <KeyScopeProvider>
      {/* THE PAPER TOOTH (A+ `body::before`). Decorative only: aria-hidden so
          it never reaches the a11y tree, pointer-events:none so it cannot take
          a click, and z-index:-1 so it paints above the canvas fill but under
          every background box — it modulates the bare sheet and nothing else.
          Empty by design; the whole layer is one CSS background-image. All of
          the reasoning, and the measured contrast floor, live beside
          `.paper-grain` in src/app/globals.css. */}
      <div className="paper-grain" aria-hidden />
      <CommandPalette groups={[PAGES_GROUP, ...entityGroups]} />
      <div className="min-h-dvh md:grid md:grid-cols-[13.5rem_1fr]">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:border focus:border-line-strong focus:bg-surface-raised focus:px-3 focus:py-2 focus:text-sm"
      >
        Skip to content
      </a>
      <aside className="hidden border-r border-line bg-surface-sunken/60 md:flex md:flex-col">
        <div className="flex h-14 items-center gap-2 border-b border-line px-5">
          <span className="inline-block size-2.5 rounded-full bg-accent" aria-hidden />
          <Wordmark />
        </div>
        <SideNav reviewCount={reviewCount} />
        <p className="border-t border-line px-5 py-3 text-[11px] leading-relaxed text-ink-faint">
          Local-first · your data never leaves this Mac
        </p>
      </aside>

      <div className="flex min-w-0 flex-col">
        {/* The rule stays full-bleed (A+ sets its rules edge to edge) while the
            masthead ROW rides the same sheet as the content it heads — before,
            the theme toggle floated 130px outboard of the sheet's right edge on
            a wide monitor. */}
        <header className="sticky top-0 z-10 h-14 border-b border-line bg-surface/90 backdrop-blur">
          <div className={`${SHEET} ${GUTTER} flex h-full items-center justify-between gap-3`}>
            <div className="flex items-center gap-2 md:hidden">
              <span className="inline-block size-2.5 rounded-full bg-accent" aria-hidden />
              <Wordmark />
            </div>
            {/* A+'s masthead slug: the standing line under the nameplate, set
                as an eyebrow rather than as body copy so it reads as a plate
                marking and not as a sentence someone forgot to finish. The
                `.eyebrow` atom carries size/tracking/case/colour; only the
                truncation is local, because this line must never be what
                wraps the 56px masthead. */}
            <div className="eyebrow hidden min-w-0 truncate md:block">
              Net worth = assets − liabilities, reconciled to the cent
            </div>
            <ThemeToggle />
          </div>
        </header>
        <MobileNav reviewCount={reviewCount} />
        <main
          id="main"
          tabIndex={-1}
          className={`${SHEET} ${GUTTER} flex-1 py-8 outline-none md:py-10`}
        >
          {children}
        </main>
      </div>
      </div>
      {/* Last in the shell so the action-toast stack is the NEXT Tab stop after
          main content, not the wrap-around point (a toast is otherwise the
          first tabbable region). Stage 1 adds the scoped `A` mnemonic
          (focusNewestToastAction, KeyScope `toast` tier) as the primary reach. */}
      <ToastHost />
      <ToastMnemonic />
    </KeyScopeProvider>
  );
}
