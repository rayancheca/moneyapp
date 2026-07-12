import { sparklineGeometry } from "@/lib/sparkline";

/** A tiny per-row value sparkline; green when the window ended up, else red. */
export function HoldingSparkline({ values }: { values: readonly number[] }) {
  const geo = sparklineGeometry(values, 64, 20, 2);
  if (!geo) return <span className="text-ink-faint">—</span>;
  const up = (values[values.length - 1] ?? 0) >= (values[0] ?? 0);
  const stroke = up ? "var(--positive)" : "var(--negative)";
  return (
    <svg width={64} height={20} viewBox="0 0 64 20" aria-hidden className="overflow-visible">
      <path d={geo.linePath} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
