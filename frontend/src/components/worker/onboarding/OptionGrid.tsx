'use client';

export type OptionItem<T extends string> = { value: T; label: string };

/**
 * The one single-select control this flow uses, in two shapes:
 *
 *   `rows` — full-width rows with a check dot on the right. For the trade
 *            list, where the labels are words of very different lengths and
 *            the list is the whole screen.
 *   `grid` — a 2-up grid of centred pills with no dot. For "Your work", where
 *            three questions share one screen and each answer set is short.
 *
 * No emojis in either: the trade rows carried them in an early draft and they
 * read as decoration next to a worker's actual trade.
 */
export function OptionGrid<T extends string>({
    options,
    value,
    onChange,
    variant = 'rows',
    disabled = false,
    labelledBy,
    describedBy,
}: {
    options: readonly OptionItem<T>[];
    value: T | null;
    onChange: (value: T) => void;
    variant?: 'rows' | 'grid';
    disabled?: boolean;
    labelledBy?: string;
    /**
     * The id of the rejection message, when there is one. It goes on the GROUP
     * rather than on each button: `aria-invalid` is a widget state that a
     * `group` does not reliably carry, and marking six trade buttons invalid
     * to explain one rejected answer is noise. Described-by on the group means
     * the sentence is read as focus enters the choices.
     */
    describedBy?: string;
}) {
    return (
        <div
            role="group"
            aria-labelledby={labelledBy}
            aria-describedby={describedBy}
            className={variant === 'grid' ? 'grid grid-cols-2 gap-2' : 'flex flex-col gap-2'}
        >
            {options.map((option) => {
                const selected = value === option.value;
                return (
                    <button
                        key={option.value}
                        type="button"
                        aria-pressed={selected}
                        disabled={disabled}
                        onClick={() => onChange(option.value)}
                        className={[
                            'flex w-full cursor-pointer items-center rounded-xl border-[1.5px] font-medium transition-colors',
                            'focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]',
                            'disabled:cursor-not-allowed disabled:opacity-60',
                            variant === 'grid'
                                ? 'min-h-[50px] justify-center px-3 py-2 text-center text-[15px]'
                                : 'min-h-[52px] justify-between gap-3 px-4 py-2.5 text-left text-base',
                            selected
                                ? 'border-[var(--jale-blue-500)] bg-[var(--jale-blue-50)] text-[var(--jale-ink)]'
                                : 'border-[var(--jale-divider)] bg-[var(--jale-card)] text-[var(--jale-ink)] hover:border-[var(--jale-blue-500)]',
                        ].join(' ')}
                    >
                        <span>{option.label}</span>
                        {variant === 'rows' ? (
                            <span
                                aria-hidden="true"
                                className={[
                                    'grid h-5 w-5 flex-none place-items-center rounded-full border-[1.5px] text-xs leading-none text-white',
                                    selected
                                        ? 'border-[var(--jale-blue-500)] bg-[var(--jale-blue-500)]'
                                        : 'border-[var(--jale-divider)]',
                                ].join(' ')}
                            >
                                {selected ? '✓' : ''}
                            </span>
                        ) : null}
                    </button>
                );
            })}
        </div>
    );
}
