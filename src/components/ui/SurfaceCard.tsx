interface SurfaceCardProps {
  children: React.ReactNode;
  className?: string;
}

export function SurfaceCard({ children, className }: SurfaceCardProps) {
  return (
    <section
      className={`rounded-(--radius-card) border border-line bg-surface-raised p-6 shadow-[0_1px_2px_oklch(0%_0_0/0.04)] ${className ?? ""}`}
    >
      {children}
    </section>
  );
}
