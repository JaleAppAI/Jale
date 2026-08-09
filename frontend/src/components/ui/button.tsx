import * as React from "react";
import { Spinner } from "./spinner";

/*
 * There was a `deep` variant here: `bg-[var(--jale-blue-900)] text-white`.
 * It was RETIRED rather than re-tinted, because the failure was structural.
 *
 * `--jale-blue-900` (#181855) is a BRAND SURFACE token, deliberately identical
 * in both themes -- it paints the landing page, the public job page's brand
 * band, the conversation drawer chrome, the dashboard hero and the legal
 * routes, and three separate source comments record that its not flipping is
 * the point. In the dark theme that put a #181855 fill on a #161b44 card
 * (1.02:1) or a #0d1130 page (1.14:1): the white label stayed perfectly
 * readable, but the button stopped reading as a button at all, far under the
 * 3:1 that WCAG 1.4.11 asks of a non-text UI boundary.
 *
 * Re-tinting `--jale-blue-900` under `.dark` would have repainted the whole
 * brand to fix one button. Minting a dark-only token just for this pairing
 * would have grown the system to keep a variant that already had only two
 * callers -- and `PostJobModal` had independently moved to `primary` with a
 * comment saying exactly why. Retiring it removes the trap instead of papering
 * over it, and folds those buttons into the one CTA colour the rest of the app
 * already uses, so the outstanding `primary` contrast decision covers them too.
 *
 * NOTE for whoever takes that decision: `primary` below paints with
 * `--jale-blue-500` DIRECTLY, not with the `--primary` role token. `.dark`
 * re-points `--primary` to #4585ff but leaves `--jale-blue-500` at #0179FF, so
 * the dark re-tint never reaches this button -- it is #0179FF in both themes
 * (fill-vs-ground 4.07:1 on the dark card, so the shape is fine). Surfaces that
 * DO use `var(--primary)`, such as the outbound message bubble in
 * `ConversationThread`, therefore render a different blue in dark than this
 * button does. Reconciling the two is part of the same sign-off.
 */
type ButtonVariant = "primary" | "secondary" | "outline" | "ghost" | "error";
type ButtonSize = "default" | "sm" | "lg";

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  loadingLabel?: string;
}

const variantClasses: Record<ButtonVariant, string> = {
  primary:
    "bg-[var(--jale-blue-500)] text-white hover:bg-[var(--jale-blue-600)] shadow-[var(--shadow-btn)]",
  secondary:
    "bg-[var(--jale-blue-50)] text-[var(--jale-blue-700)] hover:bg-[var(--jale-blue-100)]",
  outline:
    "border border-[var(--jale-divider)] bg-[var(--jale-card)] text-[var(--jale-ink)] hover:bg-[var(--jale-paper-2)]",
  ghost:
    "bg-transparent text-[var(--jale-ink)] border border-[var(--jale-divider)] hover:bg-[var(--jale-paper-2)]",
  error:
    "bg-[var(--jale-danger-bg)] text-[var(--jale-danger)] hover:opacity-90",
};

const sizeClasses: Record<ButtonSize, string> = {
  default: "h-11 px-5 text-sm",
  sm:      "h-9 px-4 text-xs",
  lg:      "h-12 px-6 text-base",
};

/**
 * Ref-forwarding so a caller can address the button itself -- `Modal`'s
 * `initialFocusRef` (a destructive dialog opening on Cancel rather than on
 * Delete) is the motivating case.
 */
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button({
  variant = "primary",
  size = "default",
  className = "",
  disabled,
  loading = false,
  loadingLabel,
  children,
  ...props
}, ref) {
  const isDisabled = disabled || loading;

  return (
    <button
      ref={ref}
      className={[
        "inline-flex items-center justify-center gap-2 rounded-full font-semibold",
        "cursor-pointer select-none whitespace-nowrap leading-none",
        "transition-all duration-150",
        "focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]",
        "active:scale-[0.98]",
        "disabled:opacity-50 disabled:pointer-events-none",
        variantClasses[variant],
        sizeClasses[size],
        className,
      ].join(" ")}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      {...props}
    >
      <span className="grid items-center justify-items-center">
        <span className={`col-start-1 row-start-1 inline-flex items-center justify-center gap-2 ${loading ? "invisible" : ""}`}>
          {children}
        </span>
        <span className={`col-start-1 row-start-1 inline-flex items-center justify-center gap-2 ${loading ? "" : "invisible"}`}>
          <Spinner size="md" />
          <span>{loadingLabel ?? children}</span>
        </span>
      </span>
    </button>
  );
});
