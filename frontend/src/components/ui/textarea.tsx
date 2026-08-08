import * as React from "react";

export function Textarea({
  className = "",
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={[
        "w-full rounded-[var(--radius-input)]",
        "border border-[var(--jale-divider)] bg-[var(--jale-input)]",
        "px-3.5 py-2.5 text-sm font-medium leading-relaxed",
        "text-[var(--jale-ink)] placeholder:text-[var(--jale-placeholder)]",
        "transition-[background-color,border-color,box-shadow] duration-150",
        "focus:outline-none focus:bg-[var(--input-focus)] focus:border-[var(--jale-blue-500)] focus:shadow-[var(--shadow-focus)]",
        "disabled:opacity-50 disabled:cursor-not-allowed resize-y",
        className,
      ].join(" ")}
      {...props}
    />
  );
}
