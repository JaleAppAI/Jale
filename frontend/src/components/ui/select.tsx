import * as React from "react";

/**
 * Ref-forwarding to the `<select>` itself, NOT to the positioning wrapper --
 * the wrapper exists only to place the chevron, and a caller asking for this
 * component's ref means the control (`Modal`'s `initialFocusRef`, `.focus()`
 * after a validation failure).
 */
export const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(function Select({ className = "", children, ...props }, ref) {
  return (
    <div className="relative">
      <select
        ref={ref}
        className={[
          "w-full min-h-[44px] rounded-[var(--radius-input)] appearance-none",
          "border border-[var(--jale-divider)] bg-[var(--jale-input)]",
          "pl-3.5 pr-9 py-2.5 text-sm font-medium",
          "text-[var(--jale-ink)]",
          "transition-[background-color,border-color,box-shadow] duration-150",
          "focus:outline-none focus:bg-[var(--input-focus)] focus:border-[var(--jale-blue-500)] focus:shadow-[var(--shadow-focus)]",
          "disabled:opacity-50 disabled:cursor-not-allowed",
          className,
        ].join(" ")}
        {...props}
      >
        {children}
      </select>
      <svg
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2"
        width="14" height="14" viewBox="0 0 20 20" fill="none"
        style={{ color: "var(--jale-ink-2)" }}
        aria-hidden
      >
        <path d="M5 8l5 5 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
});
