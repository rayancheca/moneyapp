import { formatCents, formatCentsSigned } from "@/lib/money";

interface MoneyProps {
  cents: number;
  /** show +/- and semantic flow colors */
  flow?: boolean;
  className?: string;
}

/** Tabular-numeral money display; color is semantic, never decorative. */
export function Money({ cents, flow = false, className }: MoneyProps) {
  const text = flow ? formatCentsSigned(cents) : formatCents(cents);
  const tone = !flow ? "" : cents < 0 ? "text-negative" : cents > 0 ? "text-positive" : "text-ink-muted";
  return <span className={`figures ${tone} ${className ?? ""}`.trim()}>{text}</span>;
}
