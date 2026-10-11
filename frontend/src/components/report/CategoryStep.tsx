'use client';

import { useId } from 'react';
import type { RefObject } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { SheetBody, SheetFooter } from '@/components/ui/sheet';
import { categoriesFor, type ReportCategory, type ReportRole } from '@/lib/report/categories';
import { roleNamespace } from './types';

/**
 * Step 1: what the report is about. The role's own list, in its fixed order,
 * starting on the category the screen implies -- so most people only tap Next.
 *
 * "Chosen from the screen you were on" is shown only while it is true: the
 * starting choice is still selected, and it is a real match rather than the
 * "Something else" every unmapped screen falls back to.
 */
export function CategoryStep({
    role,
    value,
    initial,
    onChange,
    onNext,
    groupRef,
}: {
    role: ReportRole;
    value: ReportCategory;
    initial: ReportCategory;
    onChange: (category: ReportCategory) => void;
    onNext: () => void;
    /** The fieldset, so the flow can put focus back on the chosen radio. */
    groupRef?: RefObject<HTMLFieldSetElement | null>;
}) {
    const t = useTranslations('report_common');
    const tRole = useTranslations(roleNamespace(role));
    const name = useId();
    const hintId = useId();
    const showHint = value === initial && initial !== 'other';

    return (
        <form
            noValidate
            className="flex min-h-0 flex-1 flex-col"
            onSubmit={(event) => {
                event.preventDefault();
                onNext();
            }}
        >
            <SheetBody>
                <fieldset ref={groupRef} aria-describedby={showHint ? hintId : undefined} className="min-w-0">
                    <legend className="mb-3 text-lg font-bold text-[var(--jale-ink)]">{t('category_legend')}</legend>
                    <div className="space-y-2">
                        {categoriesFor(role).map((code) => (
                            <label
                                key={code}
                                className={[
                                    'flex min-h-11 cursor-pointer items-center gap-3 rounded-[var(--radius-input)] border px-4 py-2.5',
                                    'border-[var(--jale-divider)] bg-[var(--jale-card)] text-sm font-semibold text-[var(--jale-ink)]',
                                    'transition-colors hover:bg-[var(--jale-paper-2)]',
                                    'has-[:checked]:border-[var(--jale-blue-500)] has-[:checked]:bg-[var(--jale-blue-50)]',
                                    'has-[:focus-visible]:shadow-[var(--shadow-focus)]',
                                ].join(' ')}
                            >
                                <input
                                    type="radio"
                                    name={name}
                                    value={code}
                                    checked={value === code}
                                    onChange={() => onChange(code)}
                                    className="h-4 w-4 shrink-0 accent-[var(--jale-blue-500)] focus:outline-none"
                                />
                                <span className="min-w-0">{tRole(`categories.${code}`)}</span>
                            </label>
                        ))}
                    </div>
                    {showHint ? (
                        <p id={hintId} className="mt-3 text-sm text-[var(--jale-ink-2)]">
                            {tRole('category_hint')}
                        </p>
                    ) : null}
                </fieldset>
            </SheetBody>
            <SheetFooter>
                <Button type="submit" className="w-full sm:w-auto">
                    {t('next')}
                </Button>
            </SheetFooter>
        </form>
    );
}
