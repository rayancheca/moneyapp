import { SideNav } from "./SideNav";
import { MobileNav } from "./MobileNav";
import { ThemeToggle } from "./ThemeToggle";

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
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
        <SideNav />
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
        <MobileNav />
        <main
          id="main"
          tabIndex={-1}
          className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 outline-none md:px-8 md:py-10"
        >
          {children}
        </main>
      </div>
    </div>
  );
}
