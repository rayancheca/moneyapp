import { createBudgetAction } from "@/app/budgets/actions";
import { Field, Input, Select } from "@/components/ui/Field";
import type { BudgetableCategory } from "@/services/budgets";

/** Create-budget form — server-rendered; the action Zod-validates everything. */
export function BudgetForm({ categories }: { categories: BudgetableCategory[] }) {
  return (
    <form action={createBudgetAction} className="grid gap-3 md:grid-cols-3">
      <Field label="Category">
        <Select name="categoryId" required>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.depth === 1 ? ` ${c.name}` : c.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Period">
        <Select name="period" required defaultValue="monthly">
          <option value="daily">Daily</option>
          <option value="weekly">Weekly (ISO, Mon–Sun)</option>
          <option value="monthly">Monthly</option>
          <option value="annual">Annual</option>
        </Select>
      </Field>
      <Field label="Amount">
        <Input name="amount" required placeholder="600.00" inputMode="decimal" className="figures" />
      </Field>
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
