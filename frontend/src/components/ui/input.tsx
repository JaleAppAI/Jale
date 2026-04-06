import * as React from "react";

export function Input({
  className = "",
  ...props
}: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={[
        "w-full min-h-[44px] rounded-[var(--radius-input)]",
        "border border-border bg-input px-3 py-2.5 text-sm",
        "text-foreground placeholder:text-placeholder",
        "transition-[background-color,border-color,box-shadow] duration-200",
        "focus:outline-none focus:bg-input-focus focus:border-primary focus:shadow-[var(--shadow-focus)]",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        className,
      ].join(" ")}
      {...props}
    />
  );
}
