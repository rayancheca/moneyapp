import { sparklineGeometry } from "@/lib/sparkline";

export type SparklineTone = "positive" | "negative" | "neutral";

const TONE_CLASS: Record<SparklineTone, string> = {
  positive: "text-positive",
  negative: "text-negative",
  neutral: "text-ink-faint",
};

interface SparklineProps {
  /** ordered series values (cents); fewer than 2 renders nothing */
  values: readonly number[];
  tone?: SparklineTone;
  width?: number;
  height?: number;
  className?: string;
}

/**
 * Tiny inline balance chart for account cards. Pure SVG (no chart lib) —
 * decorative next to the printed figures, so it's hidden from readers.
 * Color rides on currentColor via the tone class: green up, red down.
 */
export function Sparkline({
  values,
  tone = "neutral",
  width = 96,
  height = 28,
  className,
}: SparklineProps) {
  const geo = sparklineGeometry(values, width, height);
  if (!geo) return null;
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      aria-hidden="true"
      className={`shrink-0 ${TONE_CLASS[tone]} ${className ?? ""}`.trim()}
    >
      <path d={geo.areaPath} fill="currentColor" opacity={0.08} />
      <path
        d={geo.linePath}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={geo.lastX} cy={geo.lastY} r={1.75} fill="currentColor" />
    </svg>
  );
}
