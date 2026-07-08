import { SurfaceCard } from "@/components/ui/SurfaceCard";

const SETUP_STEPS = [
  {
    step: "01",
    title: "Add your accounts",
    detail: "Chase, Discover, Capital One, SoFi, Robinhood — typed as checking, savings, credit, or investment.",
  },
  {
    step: "02",
    title: "Enter current balances",
    detail: "Net worth appears instantly: assets minus liabilities, credit cards counted against you.",
  },
  {
    step: "03",
    title: "Upload statements",
    detail: "Two years of history reconstructed and reconciled to the cent, statement by statement.",
  },
];

export default function DashboardPage() {
  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-xs font-medium uppercase tracking-[0.14em] text-ink-faint">
          Net worth
        </h1>
        <p aria-hidden className="figures mt-2 text-5xl font-semibold tracking-tight text-ink-faint">
          $&thinsp;—
        </p>
        <p className="mt-3 max-w-prose text-sm text-ink-muted">
          No accounts yet. Add your accounts and balances to see your net worth today — upload
          statements to reconstruct the last two years.
        </p>
      </header>

      <div className="grid gap-4 md:grid-cols-3">
        {SETUP_STEPS.map((s) => (
          <SurfaceCard key={s.step} className="space-y-2">
            <span className="figures text-xs text-accent">{s.step}</span>
            <h2 className="text-sm font-medium">{s.title}</h2>
            <p className="text-[13px] leading-relaxed text-ink-muted">{s.detail}</p>
          </SurfaceCard>
        ))}
      </div>
    </div>
  );
}
