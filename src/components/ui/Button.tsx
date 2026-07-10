import { Icon, type IconName } from "@/components/shell/Icon";

type ButtonVariant = "primary" | "secondary" | "ghost" | "destructive";
type ButtonSize = "sm" | "md";

const BASE =
  "inline-flex items-center justify-center gap-1.5 rounded-md font-medium duration-(--duration-fast) disabled:pointer-events-none disabled:opacity-50";

/* primary animates opacity (solid accent bg has no hover token); the rest animate colors */
const VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-accent text-surface-raised transition-opacity hover:opacity-90 active:opacity-80",
  secondary: "border border-line bg-surface-raised transition-colors hover:border-line-strong",
  ghost: "transition-colors hover:bg-surface-sunken",
  destructive:
    "border border-line text-negative transition-colors hover:border-negative hover:bg-negative-soft",
};

const SIZE: Record<ButtonSize, string> = {
  sm: "px-2.5 py-1 text-xs",
  md: "px-3 py-1.5 text-sm",
};

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** left-aligned glyph */
  icon?: IconName;
  /** swaps the glyph for a spinner and disables the button */
  pending?: boolean;
}

export function Button({
  variant = "primary",
  size = "md",
  icon,
  pending = false,
  disabled,
  className,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      className={`${BASE} ${VARIANT[variant]} ${SIZE[size]} ${className ?? ""}`.trim()}
    >
      {pending ? (
        <Icon name="spinner" className="size-3.5 animate-spin" />
      ) : icon ? (
        <Icon name={icon} className="size-3.5" />
      ) : null}
      {children}
    </button>
  );
}

/* square footprints sized to line up with the sm/md text buttons */
const ICON_BUTTON_SIZE: Record<ButtonSize, string> = {
  sm: "size-6",
  md: "size-8",
};

const GLYPH_SIZE: Record<ButtonSize, string> = {
  sm: "size-3.5",
  md: "size-4",
};

interface IconButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  icon: IconName;
  /** icon-only buttons have no visible text — a label is non-negotiable */
  "aria-label": string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  pending?: boolean;
}

export function IconButton({
  icon,
  variant = "ghost",
  size = "md",
  pending = false,
  disabled,
  className,
  ...rest
}: IconButtonProps) {
  return (
    <button
      {...rest}
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      className={`${BASE} ${VARIANT[variant]} ${ICON_BUTTON_SIZE[size]} ${className ?? ""}`.trim()}
    >
      <Icon
        name={pending ? "spinner" : icon}
        className={`${GLYPH_SIZE[size]} ${pending ? "animate-spin" : ""}`.trim()}
      />
    </button>
  );
}
