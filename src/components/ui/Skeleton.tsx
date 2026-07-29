import { PRESSED_SLOT } from "./letterpress";

/* A loading bone is the shape of a figure not yet printed, so it is a slot
   pressed into the page rather than a floating grey box. */
const BONE = `animate-pulse rounded bg-surface-sunken ${PRESSED_SLOT}`;

interface SkeletonProps {
  className?: string;
}

export function Skeleton({ className }: SkeletonProps) {
  return <div aria-hidden className={`${BONE} ${className ?? ""}`.trim()} />;
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
          className={`h-3 ${BONE} ${lines > 1 && i === lines - 1 ? "w-2/3" : ""}`.trim()}
        />
      ))}
    </div>
  );
}
