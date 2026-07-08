import { SurfaceCard } from "./SurfaceCard";

interface EmptyStateProps {
  title: string;
  description: string;
  phase?: string;
}

export function EmptyState({ title, description, phase }: EmptyStateProps) {
  return (
    <SurfaceCard className="flex flex-col items-start gap-2 border-dashed">
      <h2 className="text-sm font-medium">{title}</h2>
      <p className="max-w-prose text-sm leading-relaxed text-ink-muted">{description}</p>
      {phase ? (
        <span className="mt-2 rounded-full bg-surface-sunken px-2.5 py-1 text-[11px] font-medium text-ink-faint">
          {phase}
        </span>
      ) : null}
    </SurfaceCard>
  );
}
