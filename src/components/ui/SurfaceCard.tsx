interface SurfaceCardProps {
  children: React.ReactNode;
  className?: string;
  /** inline style pass-through (the S8 focus morph sets view-transition-name) */
  style?: React.CSSProperties;
}

export function SurfaceCard({ children, className, style }: SurfaceCardProps) {
  return (
    <section
      style={style}
      className={`rounded-(--radius-card) border border-line bg-surface-raised p-6 shadow-[0_1px_2px_oklch(0%_0_0/0.04)] ${className ?? ""}`}
    >
      {children}
    </section>
  );
}
