import * as React from "react";

/**
 * The app's boolean toggle card.
 *
 * `description` (optional) adds a second, quieter line under the label. When
 * it is given, the checkbox is named by the label alone and described by that
 * line, so a screen reader says "Day, checkbox" and then the help, rather than
 * one long name. `disabled` (optional) greys the card and stops the toggle.
 * `invalid` (optional) marks the checkbox `aria-invalid`, and `errorId`
 * (optional) adds the id of the sentence saying why to its description.
 * `focusRing` (optional) draws the focus shadow on the card while its hidden
 * checkbox has keyboard focus, so focus can be seen.
 * Without these props the card renders exactly as before.
 */
export function CheckboxCard({
  checked,
  label,
  onChange,
  description,
  disabled,
  invalid,
  errorId,
  focusRing,
  "data-guide": guide,
}: {
  checked: boolean;
  label: string;
  onChange: () => void;
  description?: string;
  disabled?: boolean;
  invalid?: boolean;
  errorId?: string;
  focusRing?: boolean;
  /** A step-by-step guide's hook (`data-guide`, see `components/tutorials/spotlight`). */
  "data-guide"?: string;
}) {
  const labelId = React.useId();
  const descriptionId = React.useId();
  return (
    <label
      data-guide={guide}
      className={[
        "flex items-center gap-2 select-none",
        disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
        "rounded-[var(--radius-input)] border px-3 py-2.5 text-sm font-medium",
        "transition-[background-color,border-color,box-shadow] duration-150",
        focusRing ? "has-[:focus-visible]:shadow-[var(--shadow-focus)]" : "",
      ].join(" ")}
      style={{
        borderColor: checked ? "var(--jale-blue-500)" : "var(--jale-divider)",
        background: checked ? "var(--jale-blue-50)" : "var(--jale-input)",
        color: checked ? "var(--jale-blue-700)" : "var(--jale-ink)",
        // With `focusRing`, an unchecked card leaves the shadow to the class,
        // which an inline "none" would override.
        boxShadow: checked ? "var(--shadow-focus)" : focusRing ? undefined : "none",
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
        aria-describedby={[description ? descriptionId : null, errorId ?? null].filter(Boolean).join(" ") || undefined}
        aria-invalid={invalid || undefined}
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
