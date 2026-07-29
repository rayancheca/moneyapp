import { SurfaceCard } from "./SurfaceCard";

interface EmptyStateProps {
  title: string;
  description: string;
}

export function EmptyState({ title, description }: EmptyStateProps) {
  return (
    // an empty state is a blank leaf, not a raised plate: it holds no figures,
    // so it has no business being the most present thing on the page
    <SurfaceCard tone="blank" className="flex flex-col items-start gap-2 border-dashed">
      <h2 className="text-sm font-medium text-ink-display">{title}</h2>
      <p className="max-w-prose text-sm leading-relaxed text-ink-muted">{description}</p>
    </SurfaceCard>
  );
}
