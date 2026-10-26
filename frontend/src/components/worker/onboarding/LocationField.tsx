'use client';
import { useTranslations } from 'next-intl';
import { LocationPicker } from '@/components/ui/LocationPicker';
import { EMPTY_LOCATION_DRAFT, locationStepValue, type LocationDraft } from '@/lib/onboarding-flow';

/**
 * The real `LocationPicker` (the bundled ZIP/city dataset every other form
 * uses), plus a chip that says what we actually resolved.
 *
 * The input is NEVER swapped out for the chip, which is the one place this
 * departs from the prototype's drawing. A bare 5-digit box counts as a ZIP the
 * moment the fifth digit lands, and replacing the field at that instant would
 * yank it out from under a worker who was still typing — or who meant to pick
 * their city from the ZIP's dropdown. The chip appears underneath instead, so
 * "we understood El Paso, TX" and "we understood ZIP 79901" are both visible
 * without the field moving.
 */
export function LocationField({
    value,
    onChange,
    onLeave,
    disabled = false,
    invalid = false,
    warn = false,
    describedBy,
    placeholder,
    'data-guide': guide,
}: {
    value: LocationDraft;
    onChange: (value: LocationDraft) => void;
    /** Focus left the field (the box, its list and its chip) for somewhere else on the page. */
    onLeave?: () => void;
    disabled?: boolean;
    invalid?: boolean;
    /** Rings the box in the warning colour: there is text in it that is not a place yet. */
    warn?: boolean;
    describedBy?: string;
    placeholder?: string;
    /** A step-by-step guide's hook (`data-guide`); the field also says `data-resolved` once it holds a place. */
    'data-guide'?: string;
}) {
    const t = useTranslations('worker_onboarding.about');
    const resolved = locationStepValue(value);

    return (
        <div
            className="flex flex-col gap-2"
            data-guide={guide}
            data-resolved={resolved ? '' : undefined}
            onBlur={(event) => {
                // Moving between the box and the chip's clear button is still
                // inside the field; only leaving it altogether counts.
                const next = event.relatedTarget;
                if (next instanceof Node && event.currentTarget.contains(next)) return;
                onLeave?.();
            }}
        >
            <div className={warn ? 'rounded-[10px] ring-2 ring-[var(--jale-warning)]' : undefined}>
                <LocationPicker
                    value={value.text}
                    placeholder={placeholder}
                    disabled={disabled}
                    invalid={invalid}
                    describedBy={describedBy}
                    picked={Boolean(value.city && value.state)}
                    onChange={(picked) => {
                        onChange({
                            text: picked.label,
                            city: picked.city,
                            state: picked.state,
                            zip: picked.zip,
                        });
                    }}
                />
            </div>
            {resolved ? (
                <div>
                    <span className="inline-flex items-center gap-2 rounded-full border border-[var(--jale-divider)] bg-[var(--jale-card)] py-1.5 pl-3 pr-1.5 text-sm font-semibold text-[var(--jale-ink)]">
                        {resolved.kind === 'zip' ? resolved.zip : `${resolved.city}, ${resolved.state}`}
                        {resolved.kind === 'zip' ? (
                            <small className="font-normal text-[var(--jale-ink-2)]">· {t('zip')}</small>
                        ) : null}
                        <button
                            type="button"
                            aria-label={t('clear_location')}
                            disabled={disabled}
                            onClick={() => onChange({ ...EMPTY_LOCATION_DRAFT })}
                            className="grid h-[26px] w-[26px] cursor-pointer place-items-center rounded-full border-0 bg-[var(--jale-input)] text-[13px] text-[var(--jale-ink-2)] transition-colors hover:text-[var(--jale-ink)] focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)] disabled:cursor-not-allowed"
                        >
                            <span aria-hidden="true">✕</span>
                        </button>
                    </span>
                </div>
            ) : null}
        </div>
    );
}
