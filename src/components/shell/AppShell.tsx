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

export function AppShell({ children, reviewCount, entityGroups }: AppShellProps) {
  return (
    <KeyScopeProvider>
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
          <span className="text-sm font-semibold tracking-tight">MoneyApp</span>
        </div>
        <SideNav reviewCount={reviewCount} />
        <p className="border-t border-line px-5 py-3 text-[11px] leading-relaxed text-ink-faint">
          Local-first · your data never leaves this Mac
        </p>
      </aside>

      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-10 flex h-14 items-center justify-between gap-3 border-b border-line bg-surface/90 px-4 backdrop-blur md:px-8">
          <div className="flex items-center gap-2 md:hidden">
            <span className="inline-block size-2.5 rounded-full bg-accent" aria-hidden />
            <span className="text-sm font-semibold tracking-tight">MoneyApp</span>
          </div>
          <div className="hidden text-xs text-ink-faint md:block">
            Net worth = assets − liabilities, reconciled to the cent
          </div>
          <ThemeToggle />
        </header>
        <MobileNav reviewCount={reviewCount} />
        <main
          id="main"
          tabIndex={-1}
          className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 outline-none md:px-8 md:py-10"
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
