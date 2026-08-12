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
 * That `primary` contrast decision has since been taken, and this is its
 * outcome: `--jale-blue-500` is #0064d6 and `.dark` no longer re-points
 * `--primary`, so the one CTA blue is 5.54:1 under white in BOTH themes (it was
 * 4.05:1 here and 3.47:1 on the `var(--primary)` bubble in `ConversationThread`
 * -- two different blues, both under AA). `primary` below still paints
 * `--jale-blue-500` directly rather than the `--primary` role token, which is
 * now harmless because the two resolve to the same colour; prefer `--primary`
 * for anything new.
 *
 * Residual, accepted with the decision: a darker CTA separates less from the
 * dark grounds than the old light-blue re-tint did (fill-vs-ground 2.98:1 on
 * `--jale-card`, 3.33:1 on the page, vs 4.06/4.54 before). Label legibility --
 * the thing WCAG 1.4.3 governs -- went up, and `--shadow-btn` still lifts the
 * shape off the card. If the dark card boundary needs more, that is a
 * `--jale-card`/outline decision, not another CTA blue.
 *
 * FILL-VS-GROUND, MEASURED, ON THE FIXED-NAVY SURFACES THIS BUTTON ACTUALLY
 * LANDS ON. These are the brand bands that stay navy in BOTH themes, so unlike
 * the themed-card numbers above they are not a dark-mode-only story:
 *
 *   employer dashboard navy hero  `--jale-blue-900` #181855   2.92:1
 *   landing hero CTA              `--jale-blue-900` #181855   2.92:1
 *   landing nav CTA               `--jale-blue-900` #181855   2.92:1
 *   landing "worker" card         `--jale-blue-900` #181855   2.92:1
 *   landing employer CTA          `--jale-blue-950` #0e0e3d   3.30:1
 *   auth navy panel               -- no primary fill: every auth button renders
 *                                    on the themed `--jale-card` column, 4.64:1
 *   j/[code] navy band            -- no primary fill: the band holds only the
 *                                    wordmark; its CTA sits on the white card
 *
 * Nothing here is egregious (the floor is 2.92:1, roughly twice the ~1.5:1 where
 * a fill genuinely dissolves into its ground), so no per-surface compensation is
 * added. The standard reading of WCAG 1.4.11 is that it applies to visual
 * information "required to identify" a control, and the boundary is not the sole
 * identifier for a filled button: the white label is 5.54:1 on the fill, and the
 * pill shape, padding and hover/focus states all carry the affordance. A filled
 * control whose LABEL passes 1.4.3 at 4.5:1 is commonly accepted on that basis.
 * The nav's login pills are a different shape entirely -- `--jale-blue-500` at
 * 20% over the navy (#13276f, 1.19:1 vs the band) -- and are identified by a
 * white label at 13.57:1 plus their border, not by the tint.
 *
 * The inverse rule matters more and is the one that keeps getting broken: this
 * blue is tuned to carry white ON it, never to be READ against navy. Any TEXT or
 * icon on a fixed-navy ground uses `--jale-blue-300`; see the landing page.
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
