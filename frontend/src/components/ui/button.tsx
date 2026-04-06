import * as React from "react";

type ButtonVariant = "primary" | "outline" | "ghost" | "error";
type ButtonSize = "default" | "sm" | "lg";

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

const variantClasses: Record<ButtonVariant, string> = {
  primary:
    "bg-primary text-primary-fg hover:bg-primary-hover hover:shadow-[var(--shadow-btn)]",
  outline:
    "border border-border bg-card text-foreground hover:bg-input",
  ghost:
    "text-foreground hover:bg-input",
  error:
    "bg-error/10 text-error hover:bg-error/20",
};

const sizeClasses: Record<ButtonSize, string> = {
  default: "h-11 px-5 text-sm",
  sm: "h-9 px-3 text-sm",
  lg: "h-12 px-6 text-base",
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
        "inline-flex items-center justify-center rounded-full font-semibold",
        "cursor-pointer select-none whitespace-nowrap",
        "transition-all duration-200",
        "focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]",
        "active:translate-y-px",
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
