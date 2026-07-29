import { PRESSED_SLOT } from "./letterpress";

type BadgeTone = "neutral" | "accent" | "positive" | "negative" | "warning" | "info";

/* -soft bg + solid tone text — every tone meets AA on its own tint
   (src/lib/state-contrast.test.ts), matching SeriesTable's STATUS_STYLE idiom */
const TONE: Record<BadgeTone, string> = {
  neutral: "bg-surface-sunken text-ink-muted",
  accent: "bg-accent-soft text-accent",
  positive: "bg-positive-soft text-positive",
  negative: "bg-negative-soft text-negative",
  warning: "bg-warning-soft text-warning",
  info: "bg-info-soft text-info",
};

interface BadgeProps {
  tone?: BadgeTone;
  children: React.ReactNode;
  className?: string;
}

export function Badge({ tone = "neutral", children, className }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ${TONE[tone]} ${className ?? ""}`.trim()}
    >
      {children}
    </span>
  );
}

const LETTER_MEANING = {
  T: "Transfer",
  R: "Recurring",
  I: "Income",
} as const;

type BadgeLetter = keyof typeof LETTER_MEANING;

interface LetterBadgeProps {
  letter: BadgeLetter;
  className?: string;
}

export function LetterBadge({ letter, className }: LetterBadgeProps) {
  const meaning = LETTER_MEANING[letter];
  return (
    <span
      title={meaning}
      className={`figures inline-flex size-4 items-center justify-center rounded bg-surface-sunken ${PRESSED_SLOT} text-[10px] font-medium text-ink-faint ${className ?? ""}`.trim()}
    >
      <span aria-hidden>{letter}</span>
      <span className="sr-only">{meaning}</span>
    </span>
  );
}
