import { Icon, type IconName } from "@/components/shell/Icon";
import { CONTROL_MOTION, PRESS } from "./letterpress";

type ButtonVariant = "primary" | "secondary" | "ghost" | "destructive";
type ButtonSize = "sm" | "md";

/**
 * Every control in this direction is a struck pill (the mockup's `.ctl`), and
 * every control presses one pixel into the page when you push it — the single
 * gesture that sells "ink on paper" rather than "boxes on a screen".
 * CONTROL_MOTION carries the shared transition + active translate; a variant
 * only says what its surface is.
 */
const BASE =
  `inline-flex items-center justify-center gap-1.5 rounded-full font-medium ${CONTROL_MOTION} disabled:pointer-events-none disabled:opacity-50`;

const VARIANT: Record<ButtonVariant, string> = {
  // the one filled control: already the raised sheet, so it is the only
  // variant that starts at PRESS.card. A solid accent has no hover token, so
  // it dims rather than warming to the leaf tone.
  primary: `bg-accent text-surface-raised ${PRESS.card} hover:opacity-90 active:opacity-80`,
  secondary: `border border-line bg-surface-raised ${PRESS.rule} hover:border-line-strong hover:bg-surface-leaf`,
  // no border, so no press shadow either: a ghost is unprinted paper until
  // the cursor warms it
  ghost: "hover:bg-surface-leaf",
  destructive: `border border-line text-negative ${PRESS.rule} hover:border-negative hover:bg-negative-soft`,
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
