import * as React from "react";

export function CheckboxCard({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange: () => void;
}) {
  return (
    <label
      className={[
        "flex items-center gap-2 cursor-pointer select-none",
        "rounded-[var(--radius-input)] border px-3 py-2.5 text-sm font-medium",
        "transition-[background-color,border-color,box-shadow] duration-150",
      ].join(" ")}
      style={{
        borderColor: checked ? "var(--jale-blue-500)" : "var(--jale-divider)",
        background: checked ? "var(--jale-blue-50)" : "var(--jale-input)",
        color: checked ? "var(--jale-blue-700)" : "var(--jale-ink)",
        boxShadow: checked ? "var(--shadow-focus)" : "none",
      }}
    >
      <span
        className="flex items-center justify-center rounded"
        style={{
          width: 18,
          height: 18,
          background: checked ? "var(--jale-blue-500)" : "var(--jale-card)",
          border: `1.5px solid ${checked ? "var(--jale-blue-500)" : "var(--jale-divider)"}`,
          flexShrink: 0,
        }}
      >
        {checked && (
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden>
            <path d="M3 8.5l3 3 7-7" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </span>
      <input type="checkbox" checked={checked} onChange={onChange} className="sr-only" />
      <span>{label}</span>
    </label>
  );
}
