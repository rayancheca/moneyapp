import { PRESSED_SLOT } from "./letterpress";

/* The one canonical field style — replaces the FIELD consts previously
   copy-pasted across AccountForm/AnchorForm/BudgetForm/HoldingForm/
   FiltersBar/settings. Exactly two geometries exist in the app today:
   "md" (the form default, `w-full px-3 py-2`) and "sm" (the compact
   `px-2.5 py-1.5` used by FiltersBar) — kept byte-faithful to those call
   sites so adoption is pixel-neutral. */
/* A field is the one thing on the page that is pressed INTO the paper rather
   than raised off it: the leaf tone plus PRESSED_SLOT's inner ink pool, and
   pointedly no catch-light — that inversion is what makes a slot read as a
   slot next to a card that shares its border colour. Contrast is measured, not
   assumed: --ink on --surface-leaf is 15.70:1 light / 15.42:1 dark, and the
   placeholder moves to --annotation, which is a strictly HIGHER ratio than the
   --ink-faint it replaces in both themes (5.44 vs 4.99 light, 6.09 vs 5.63
   dark). */
const FIELD_BASE =
  `rounded-md border border-line bg-surface-leaf text-sm ${PRESSED_SLOT} transition-colors duration-(--duration-fast) placeholder:text-annotation hover:border-line-strong focus:border-accent`;

const FIELD_SIZE = {
  md: "w-full px-3 py-2",
  sm: "px-2.5 py-1.5",
} as const;

export type FieldSize = keyof typeof FIELD_SIZE;

function fieldClass(fieldSize: FieldSize, className: string | undefined): string {
  return `${FIELD_BASE} ${FIELD_SIZE[fieldSize]} ${className ?? ""}`.trim();
}

interface FieldProps {
  label: string;
  hint?: string;
  /** takes precedence over hint */
  error?: string;
  className?: string;
  children: React.ReactNode;
}

export function Field({ label, hint, error, className, children }: FieldProps) {
  return (
    <label className={`grid gap-1 text-xs font-medium text-ink-muted ${className ?? ""}`.trim()}>
      {label}
      {children}
      {error ? (
        <span className="font-normal text-negative">{error}</span>
      ) : hint ? (
        // a hint is marginalia, so it is set in --annotation: the token exists
        // for exactly this, and it reads darker than --ink-faint in light and
        // lighter in dark, i.e. it is a contrast improvement in both themes
        <span className="font-normal text-annotation">{hint}</span>
      ) : null}
    </label>
  );
}

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  fieldSize?: FieldSize;
}

export function Input({ fieldSize = "md", className, ...rest }: InputProps) {
  return <input {...rest} className={fieldClass(fieldSize, className)} />;
}

interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  fieldSize?: FieldSize;
}

export function Select({ fieldSize = "md", className, children, ...rest }: SelectProps) {
  return (
    <select {...rest} className={fieldClass(fieldSize, className)}>
      {children}
    </select>
  );
}

interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> {
  label: string;
}

export function Checkbox({ label, className, ...rest }: CheckboxProps) {
  return (
    <label
      className={`flex items-center gap-1.5 text-xs text-ink-muted ${className ?? ""}`.trim()}
    >
      <input {...rest} type="checkbox" className="size-3.5 accent-accent" />
      {label}
    </label>
  );
}
