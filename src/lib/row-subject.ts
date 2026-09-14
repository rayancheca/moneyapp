import { formatDayFull } from "./format-date";
import { formatCentsSigned } from "./money";

/**
 * What a control on a transaction row is named after — WHICH row, among the
 * rows it is listed with.
 *
 * 🔴 A description is not an identity. `/recurring/<Fordham Payroll>` rendered 56
 * "Actions for DIRECT DEPOSIT FORDHAM UNIVERSI PAYROLL" menus, one item of which
 * DETACHES the row, and the ledger named 4,804 of its 10,279 checkboxes "Select
 * <description>" beside a sibling of the same name on the same page (measured
 * 2026-09-14). A recurring series repeats its bank text by construction, so the
 * description is exactly the field that cannot tell two of its rows apart.
 *
 * The rule is `/imports`' (`importRowQualifiers`): qualify ONLY where the name
 * repeats, and fall through to a finer qualifier until it no longer does —
 *  1. a description unique in the list stays bare;
 *  2. a repeated one gains what the row itself prints — its signed amount (as
 *     `<Money flow>` shows it), its day spelled for prose, and its account;
 *  3. rows identical in all of that are numbered "(k of n)" in the order passed,
 *     which is the order the list renders.
 * ⚠️ The day is joined with "on", never "in": `/^Select \S+ in /` is how the
 * holdings table's checkboxes are found.
 */
export interface SubjectRow {
  id: string;
  description: string;
  amountCents: number;
  postedOn: string;
  accountName?: string | null;
}

function tally(values: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return counts;
}

export function transactionSubjects(rows: readonly SubjectRow[]): Map<string, string> {
  const byDescription = tally(rows.map((r) => r.description));
  const qualified = rows.map((r) =>
    byDescription.get(r.description) === 1
      ? r.description
      : `${r.description}, ${formatCentsSigned(r.amountCents)} on ${formatDayFull(r.postedOn)}` +
        (r.accountName ? `, ${r.accountName}` : ""),
  );
  const byQualified = tally(qualified);
  const seen = new Map<string, number>();
  return new Map(
    rows.map((r, i) => {
      const name = qualified[i] as string;
      const n = byQualified.get(name) as number;
      if (n === 1) return [r.id, name];
      const k = (seen.get(name) ?? 0) + 1;
      seen.set(name, k);
      return [r.id, `${name} (${k} of ${n})`];
    }),
  );
}
