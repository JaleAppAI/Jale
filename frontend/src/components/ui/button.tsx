import * as React from "react";

type ButtonVariant = "primary" | "deep" | "secondary" | "outline" | "ghost" | "error";
type ButtonSize = "default" | "sm" | "lg";

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

const variantClasses: Record<ButtonVariant, string> = {
  primary:
    "bg-[var(--jale-blue-500)] text-white hover:bg-[var(--jale-blue-600)] shadow-[var(--shadow-btn)]",
  deep:
    "bg-[var(--jale-blue-900)] text-white hover:bg-[var(--jale-blue-950,#0e0e3d)]",
  secondary:
    "bg-[var(--jale-blue-50)] text-[var(--jale-blue-700)] hover:bg-[var(--jale-blue-100)]",
  outline:
    "border border-[var(--jale-divider)] bg-white text-[var(--jale-ink)] hover:bg-[var(--jale-paper-2)]",
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

export function Button({
  variant = "primary",
  size = "default",
  className = "",
  disabled,
  children,
  ...props
}: ButtonProps) {
  return (
    <button
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
      disabled={disabled}
      {...props}
    >
      {children}
    </button>
  );
}
