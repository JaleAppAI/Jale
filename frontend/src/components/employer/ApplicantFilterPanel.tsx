'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import type { ApplicantFilters } from '@/lib/api/employer';
import type { ApplicationStatus } from '@/lib/status';

/**
 * Applicant filter strip for the employer job page.
 *
 * It renders inside the applicants panel (above the divided rows), so it draws
 * no box of its own beyond a hairline separator -- the panel is the ONE bordered
 * container the list lives in, and a second border here would read as two
 * stacked cards.
 *
 * The panel is a controlled, stateless view: it never fetches. `onChange` hands
 * the next filter set to the page, which drives a BACKGROUND refresh with it.
 * That is deliberate and load-bearing -- see the note on `applyFilters` in the
 * page. Filtering must not be able to blank a page the employer is reading.
 */

/** Statuses offered in the dropdown, in lifecycle order. */
const FILTER_STATUSES: ApplicationStatus[] = [
    'pending',
    'contacted',
    'talking',
    'hired',
    'not_interested',
];

/** Availability values the API accepts, matching `filters.availability_*` keys. */
const FILTER_AVAILABILITY = ['full_time', 'part_time', 'weekends', 'flexible'] as const;

export const EMPTY_APPLICANT_FILTERS: ApplicantFilters = {};

/**
 * Whether anything is actually narrowing the list.
 *
 * This is what tells "nobody has applied yet" apart from "your filters hide
 * everyone", so it must treat a blank string and a `NaN` min-experience as
 * *not* filtering -- otherwise clearing a field by hand would leave the page
 * insisting filters are still on.
 */
export function hasActiveApplicantFilters(filters: ApplicantFilters): boolean {
    if (filters.status) return true;
    if (filters.skills && filters.skills.trim().length > 0) return true;
    if (filters.availability) return true;
    if (filters.min_experience !== undefined && Number.isFinite(filters.min_experience)) return true;
    return false;
}

/*
 * NOTE ON `disabled`: none of these controls is ever disabled while the
 * filtered reload runs. Disabling a focused input blurs it, so the employer
 * would lose the caret after the first character they typed into "Skills" and
 * be unable to type a second. The busy affordance lives in the panel header
 * (a spinner) instead, where it cannot touch focus.
 */

interface Props {
    filters: ApplicantFilters;
    onChange: (filters: ApplicantFilters) => void;
}

export function ApplicantFilterPanel({ filters, onChange }: Props) {
    const t = useTranslations('employer_job_listing');
    // `employer_dashboard.applicants.status.*` is frozen shared vocabulary: the
    // dropdown must name a status exactly as the badge on the row below does.
    const tShared = useTranslations('employer_dashboard');

    const active = hasActiveApplicantFilters(filters);

    return (
        <div className="border-b border-[var(--jale-divider)] px-5 py-4">
            <div className="flex flex-wrap items-end gap-3">
                <div className="flex min-w-[9rem] flex-1 flex-col gap-1.5 sm:flex-none">
                    <label
                        htmlFor="applicant-filter-status"
                        className="text-xs font-bold uppercase tracking-wider text-[var(--jale-ink-2)]"
                    >
                        {t('filters.status')}
                    </label>
                    <Select
                        id="applicant-filter-status"
                        value={filters.status ?? ''}
                        onChange={(event) =>
                            onChange({ ...filters, status: event.target.value || undefined })
                        }
                    >
                        <option value="">{t('filters.status_all')}</option>
                        {FILTER_STATUSES.map((status) => (
                            <option key={status} value={status}>
                                {tShared(`applicants.status.${status}`)}
                            </option>
                        ))}
                    </Select>
                </div>

                <div className="flex min-w-[11rem] flex-1 flex-col gap-1.5">
                    <label
                        htmlFor="applicant-filter-skills"
                        className="text-xs font-bold uppercase tracking-wider text-[var(--jale-ink-2)]"
                    >
                        {t('filters.skills')}
                    </label>
                    <Input
                        id="applicant-filter-skills"
                        value={filters.skills ?? ''}
                        placeholder={t('filters.skills_placeholder')}
                        onChange={(event) =>
                            onChange({ ...filters, skills: event.target.value || undefined })
                        }
                    />
                </div>

                <div className="flex min-w-[9rem] flex-1 flex-col gap-1.5 sm:flex-none">
                    <label
                        htmlFor="applicant-filter-availability"
                        className="text-xs font-bold uppercase tracking-wider text-[var(--jale-ink-2)]"
                    >
                        {t('filters.availability')}
                    </label>
                    <Select
                        id="applicant-filter-availability"
                        value={filters.availability ?? ''}
                        onChange={(event) =>
                            onChange({ ...filters, availability: event.target.value || undefined })
                        }
                    >
                        <option value="">{t('filters.availability_any')}</option>
                        {FILTER_AVAILABILITY.map((value) => (
                            <option key={value} value={value}>
                                {t(`filters.availability_${value}`)}
                            </option>
                        ))}
                    </Select>
                </div>

                <div className="flex w-[7.5rem] flex-col gap-1.5">
                    <label
                        htmlFor="applicant-filter-experience"
                        className="text-xs font-bold uppercase tracking-wider text-[var(--jale-ink-2)]"
                    >
                        {t('filters.min_experience')}
                    </label>
                    <Input
                        id="applicant-filter-experience"
                        type="number"
                        min={0}
                        inputMode="numeric"
                        className="tabular-nums"
                        value={filters.min_experience ?? ''}
                        onChange={(event) =>
                            onChange({
                                ...filters,
                                // A blank box is "no minimum", never `NaN`: Number('')
                                // is 0, which would silently filter out everyone who
                                // never stated their experience.
                                min_experience: event.target.value
                                    ? Number(event.target.value)
                                    : undefined,
                            })
                        }
                    />
                </div>

                {/* Only offered once something is actually filtering. A permanently
                    visible "Clear" on an unfiltered list is a button that does
                    nothing, and it dilutes the same control in the filtered-empty
                    state where it is the only way forward. */}
                {active ? (
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => onChange(EMPTY_APPLICANT_FILTERS)}
                    >
                        {t('filters.clear')}
                    </Button>
                ) : null}
            </div>
        </div>
    );
}
