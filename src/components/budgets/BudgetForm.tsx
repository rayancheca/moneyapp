import { createBudgetAction } from "@/app/budgets/actions";
import type { BudgetableCategory } from "@/services/budgets";

const FIELD =
  "w-full rounded-md border border-line bg-surface-raised px-3 py-2 text-sm transition-colors duration-(--duration-fast) placeholder:text-ink-faint hover:border-line-strong focus:border-accent";

/** Create-budget form — server-rendered; the action Zod-validates everything. */
export function BudgetForm({ categories }: { categories: BudgetableCategory[] }) {
  return (
    <form action={createBudgetAction} className="grid gap-3 md:grid-cols-3">
      <label className="grid gap-1 text-xs font-medium text-ink-muted">
        Category
        <select name="categoryId" required className={FIELD}>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.depth === 1 ? ` ${c.name}` : c.name}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1 text-xs font-medium text-ink-muted">
        Period
        <select name="period" required defaultValue="monthly" className={FIELD}>
          <option value="daily">Daily</option>
          <option value="weekly">Weekly (ISO, Mon–Sun)</option>
          <option value="monthly">Monthly</option>
          <option value="annual">Annual</option>
        </select>
      </label>
      <label className="grid gap-1 text-xs font-medium text-ink-muted">
        Amount
        <input name="amount" required placeholder="600.00" inputMode="decimal" className={`${FIELD} figures`} />
      </label>
      <div className="md:col-span-3">
        <button
          type="submit"
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-surface-raised transition-opacity duration-(--duration-fast) hover:opacity-90 active:opacity-80"
        >
          Create budget
        </button>
      </div>
    </form>
  );
}
