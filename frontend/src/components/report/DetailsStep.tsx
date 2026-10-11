'use client';

import { useId } from 'react';
import type { ReactNode, RefObject } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SheetBody, SheetFooter } from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import { reportFailureMessageKey, type ReportFailure } from '@/lib/api/reports';
import type { ReportCategory, ReportRole } from '@/lib/report/categories';
import { FallbackContacts } from './FallbackPanel';
import { roleNamespace } from './types';

export const DESCRIPTION_MAX = 2000;
export const CONTACT_MAX = 200;

const fieldLabelClasses = 'block text-sm font-semibold text-[var(--jale-ink)]';
const hintClasses = 'text-xs text-[var(--jale-ink-2)]';

/**
 * Step 2: what happened. The one required box, the employer's urgency
 * question, the image (passed in as `screenshot`), what is sent, and -- signed
 * out -- the optional contact and the line saying the report is unverified.
 *
 * Every value lives in the flow above, so a failed send, a trip back to the
 * category, or the switch to the signed-out form never loses a word.
 */
export function DetailsStep({
    role,
    category,
    onChangeCategory,
    signedIn,
    switched,
    description,
    onDescriptionChange,
    descriptionError,
    descriptionRef,
    stopsWork,
    onStopsWorkChange,
    contact,
    onContactChange,
    screenshot,
    whatWeSend,
    failure,
    sending,
    sendDisabled,
    onSend,
}: {
    role: ReportRole;
    category: ReportCategory;
    onChangeCategory: () => void;
    signedIn: boolean;
    /** The sign-in ended while the form was open; it is now the signed-out form. */
    switched: boolean;
    description: string;
    onDescriptionChange: (value: string) => void;
    descriptionError: boolean;
    descriptionRef: RefObject<HTMLTextAreaElement | null>;
    stopsWork: boolean | null;
    onStopsWorkChange: (value: boolean) => void;
    contact: string;
    onContactChange: (value: string) => void;
    screenshot: ReactNode;
    whatWeSend: ReactNode;
    failure: ReportFailure | null;
    sending: boolean;
    sendDisabled: boolean;
    onSend: () => void;
}) {
    const t = useTranslations('report_common');
    const tRole = useTranslations(roleNamespace(role));
    const categoryId = useId();
    const descriptionId = useId();
    const descriptionHintId = useId();
    const descriptionCountId = useId();
    const descriptionErrorId = useId();
    const contactId = useId();
    const contactHintId = useId();
    const stopsWorkName = useId();

    const descriptionDescribedBy = [descriptionError ? descriptionErrorId : null, descriptionHintId, descriptionCountId]
        .filter(Boolean)
        .join(' ');

    return (
        <form
            noValidate
            className="flex min-h-0 flex-1 flex-col"
            onSubmit={(event) => {
                event.preventDefault();
                onSend();
            }}
        >
            <SheetBody>
                <div className="space-y-5">
                    {signedIn ? null : (
                        <p className="rounded-[var(--radius-input)] bg-[var(--jale-blue-50)] px-4 py-3 text-sm font-medium text-[var(--jale-blue-700)]">
                            {tRole('unverified')}
                        </p>
                    )}

                    <div className="flex items-center justify-between gap-3 rounded-[var(--radius-input)] border border-[var(--jale-divider)] px-4 py-2">
                        <p id={categoryId} className="min-w-0 text-sm font-semibold text-[var(--jale-ink)]">
                            {tRole(`categories.${category}`)}
                        </p>
                        <button
                            type="button"
                            onClick={onChangeCategory}
                            aria-describedby={categoryId}
                            className="inline-flex min-h-11 shrink-0 cursor-pointer items-center rounded-full px-3 text-sm font-semibold text-[var(--jale-blue-700)] transition-colors hover:bg-[var(--jale-blue-50)] focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
                        >
                            {t('change')}
                        </button>
                    </div>

                    <div className="space-y-1.5">
                        <label htmlFor={descriptionId} className={fieldLabelClasses}>
                            {t('description_label')}
                            <span aria-hidden="true" className="text-[var(--jale-danger-text)]"> *</span>
                        </label>
                        <p id={descriptionHintId} className={hintClasses}>
                            {tRole('description_hint')}
                        </p>
                        <Textarea
                            ref={descriptionRef}
                            id={descriptionId}
                            name="description"
                            value={description}
                            onChange={(event) => onDescriptionChange(event.target.value)}
                            required
                            maxLength={DESCRIPTION_MAX}
                            rows={4}
                            aria-invalid={descriptionError || undefined}
                            aria-describedby={descriptionDescribedBy}
                            className={descriptionError ? 'border-[var(--jale-danger)]' : ''}
                        />
                        <div className="flex items-start justify-between gap-3">
                            {descriptionError ? (
                                <p id={descriptionErrorId} className="text-sm font-medium text-[var(--jale-danger-text)]">
                                    {tRole('description_error')}
                                </p>
                            ) : (
                                <span />
                            )}
                            <p id={descriptionCountId} className={`${hintClasses} shrink-0 tabular-nums`}>
                                {t('character_count', { count: description.length, max: DESCRIPTION_MAX })}
                            </p>
                        </div>
                    </div>

                    {role === 'employer' ? (
                        <fieldset className="min-w-0">
                            <legend className={`${fieldLabelClasses} mb-2`}>{tRole('stops_work.legend')}</legend>
                            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                                {([true, false] as const).map((value) => (
                                    <label
                                        key={String(value)}
                                        className={[
                                            'flex min-h-11 cursor-pointer items-center gap-3 rounded-[var(--radius-input)] border px-4 py-2.5',
                                            'border-[var(--jale-divider)] text-sm font-semibold text-[var(--jale-ink)]',
                                            'transition-colors hover:bg-[var(--jale-paper-2)]',
                                            'has-[:checked]:border-[var(--jale-blue-500)] has-[:checked]:bg-[var(--jale-blue-50)]',
                                            'has-[:focus-visible]:shadow-[var(--shadow-focus)]',
                                        ].join(' ')}
                                    >
                                        <input
                                            type="radio"
                                            name={stopsWorkName}
                                            value={value ? 'yes' : 'no'}
                                            checked={stopsWork === value}
                                            onChange={() => onStopsWorkChange(value)}
                                            className="h-4 w-4 shrink-0 accent-[var(--jale-blue-500)] focus:outline-none"
                                        />
                                        <span className="min-w-0">
                                            {value ? tRole('stops_work.yes') : tRole('stops_work.no')}
                                        </span>
                                    </label>
                                ))}
                            </div>
                        </fieldset>
                    ) : null}

                    {signedIn ? null : (
                        <div className="space-y-1.5">
                            <label htmlFor={contactId} className={fieldLabelClasses}>
                                {tRole('contact_label')}
                            </label>
                            <p id={contactHintId} className={hintClasses}>
                                {tRole('contact_hint')}
                            </p>
                            <Input
                                id={contactId}
                                name="contact"
                                value={contact}
                                onChange={(event) => onContactChange(event.target.value)}
                                maxLength={CONTACT_MAX}
                                autoComplete="off"
                                autoCapitalize="off"
                                spellCheck={false}
                                aria-describedby={contactHintId}
                            />
                        </div>
                    )}

                    {screenshot}

                    {whatWeSend}

                    <p className="text-xs text-[var(--jale-ink-2)]">
                        <span>{tRole('notice')}</span>{' '}
                        {/* A plain anchor: /legal/privacy is a route handler outside the
                            locale tree, as on the landing footer. */}
                        <a
                            href="/legal/privacy"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-semibold text-[var(--jale-blue-700)] underline underline-offset-2 focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
                        >
                            {t('privacy_link')}
                            <span className="sr-only"> {t('new_tab')}</span>
                        </a>
                    </p>

                    {switched ? (
                        <p role="status" className="rounded-[var(--radius-input)] bg-[var(--jale-warning-bg)] px-4 py-3 text-sm font-medium text-[var(--jale-warning-text)]">
                            {tRole('session_switched')}
                        </p>
                    ) : null}

                    {failure && failure !== 'session_expired' ? (
                        <div
                            role="alert"
                            className="space-y-2 rounded-[var(--radius-input)] bg-[var(--jale-danger-bg)] px-4 py-3 text-sm text-[var(--jale-danger-text)]"
                        >
                            <p className="font-semibold">{tRole(reportFailureMessageKey(failure))}</p>
                            <p>
                                <FallbackContacts role={role} />
                            </p>
                        </div>
                    ) : null}
                </div>
            </SheetBody>
            <SheetFooter>
                <Button
                    type="submit"
                    loading={sending}
                    loadingLabel={t('sending')}
                    disabled={sendDisabled}
                    className="w-full sm:w-auto"
                >
                    {t('send')}
                </Button>
            </SheetFooter>
        </form>
    );
}
