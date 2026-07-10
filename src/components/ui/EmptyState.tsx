import { SurfaceCard } from "./SurfaceCard";

interface EmptyStateProps {
  title: string;
  description: string;
}

export function EmptyState({ title, description }: EmptyStateProps) {
  return (
    <SurfaceCard className="flex flex-col items-start gap-2 border-dashed">
      <h2 className="text-sm font-medium">{title}</h2>
      <p className="max-w-prose text-sm leading-relaxed text-ink-muted">{description}</p>
    </SurfaceCard>
  );
}
