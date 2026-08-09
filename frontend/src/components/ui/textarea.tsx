import * as React from "react";

/**
 * Ref-forwarding so a caller can address the control itself -- `Modal`'s
 * `initialFocusRef` is the motivating case, and it needs the real element, not
 * a wrapper to search inside.
 */
export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className = "", ...props }, ref) {
  return (
    <textarea
      ref={ref}
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
});
