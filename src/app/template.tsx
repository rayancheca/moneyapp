/**
 * Route transition (S10, Track 2): every navigation re-mounts this template,
 * so the incoming page plays one fade-rise — motion that clarifies "you moved"
 * without a library. Compositor-only (opacity/transform); the global
 * prefers-reduced-motion guard in globals.css zeroes it entirely.
 */
export default function Template({ children }: { children: React.ReactNode }) {
  return <div className="animate-fade-rise">{children}</div>;
}
