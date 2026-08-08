import * as React from "react";

export function Input({
  className = "",
  ...props
}: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={[
        "w-full min-h-[44px] rounded-[var(--radius-input)]",
        "border border-[var(--jale-divider)] bg-[var(--jale-input)]",
        "px-3.5 py-2.5 text-sm font-medium",
        "text-[var(--jale-ink)] placeholder:text-[var(--jale-placeholder)]",
        "transition-[background-color,border-color,box-shadow] duration-150",
        "focus:outline-none focus:bg-[var(--input-focus)] focus:border-[var(--jale-blue-500)] focus:shadow-[var(--shadow-focus)]",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        className,
      ].join(" ")}
      {...props}
    />
  );
}
