interface SkeletonProps {
  className?: string;
}

export function Skeleton({ className }: SkeletonProps) {
  return (
    <div aria-hidden className={`animate-pulse rounded bg-surface-sunken ${className ?? ""}`.trim()} />
  );
}

interface SkeletonTextProps {
  lines?: number;
  className?: string;
}

export function SkeletonText({ lines = 3, className }: SkeletonTextProps) {
  return (
    <div aria-hidden className={`grid gap-2 ${className ?? ""}`.trim()}>
      {Array.from({ length: lines }, (_, i) => (
        <div
          key={i}
          className={`h-3 animate-pulse rounded bg-surface-sunken ${
            lines > 1 && i === lines - 1 ? "w-2/3" : ""
          }`.trim()}
        />
      ))}
    </div>
  );
}
