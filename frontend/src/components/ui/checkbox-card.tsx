import * as React from "react";

/**
 * The app's boolean toggle card.
 *
 * `description` (optional) adds a second, quieter line under the label. When
 * it is given, the checkbox is named by the label alone and described by that
 * line, so a screen reader says "Day, checkbox" and then the help, rather than
 * one long name. `disabled` (optional) greys the card and stops the toggle.
 * Without either prop the card renders exactly as before.
 */
export function CheckboxCard({
  checked,
  label,
  onChange,
  description,
  disabled,
}: {
  checked: boolean;
  label: string;
  onChange: () => void;
  description?: string;
  disabled?: boolean;
}) {
  const labelId = React.useId();
  const descriptionId = React.useId();
  return (
    <label
      className={[
        "flex items-center gap-2 select-none",
        disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
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
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        className="sr-only"
        aria-labelledby={description ? labelId : undefined}
        aria-describedby={description ? descriptionId : undefined}
      />
      {description ? (
        <span className="flex min-w-0 flex-col gap-0.5">
          <span id={labelId} className="font-bold">{label}</span>
          <span id={descriptionId} className="text-xs font-normal text-[var(--jale-ink-2)]">{description}</span>
        </span>
      ) : (
        <span>{label}</span>
      )}
    </label>
  );
}
