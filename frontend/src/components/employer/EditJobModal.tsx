'use client';

import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/contexts/AuthContext';
import { useErrorMessage } from '@/hooks/useErrorMessage';
import { ApiError, updateJob, type EmployerJobDetail } from '@/lib/api/employer';
import {
    DOC_TYPES, LANGUAGE_OPTIONS, TRADE_CATEGORIES, PAY_INTERVALS,
    type DocType, type PayInterval, type JobForm,
    jobFormToEditPayload, jobToForm, validateJobNumbers, applyLocationToJobForm, validateJobLocationFields,
} from '@/lib/job-form';
import { Button } from '@/components/ui/button';
import { InlineFeedback } from '@/components/ui/inline-feedback';
import { Input } from '@/components/ui/input';
import { LocationPicker } from '@/components/ui/LocationPicker';
import { Modal } from '@/components/ui/modal';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { locationDatasetFailed } from '@/lib/location-search';

/**
 * Edit an existing job posting.
 *
 * The dialog chrome is the foundation `Modal`, which is what buys focus
 * containment, Escape-to-close, the ink backdrop, the page scroll lock and
 * focus restored to whatever opened it. The previous hand-rolled overlay had
 * none of those: Tab walked straight out of the form into the page behind it,
 * Escape did nothing, and closing left focus on `<body>`.
 *
 * `Modal` is designed to stay MOUNTED and be driven by `open` (its
 * focus-in/focus-restore effects key off that transition), so this component is
 * rendered unconditionally by the page and resets its own form on each open --
 * see the transition effect below.
 *
 * Validation and submit semantics are unchanged: `lib/job-form.ts` remains the
 * single source of truth for both, shared with the create flow.
 */

interface Props {
    open: boolean;
    job: EmployerJobDetail;
    onClose: () => void;
    onJobUpdated: (job: EmployerJobDetail) => void;
}

export function EditJobModal({ open, job, onClose, onJobUpdated }: Props) {
    // `employer_dashboard.modal.*` is the job-FORM vocabulary, shared verbatim
    // with PostJobModal. Restating it in this page's own namespace would let the
    // create and edit forms drift into naming the same field two ways.
    const t = useTranslations('employer_dashboard');
    const tCommon = useTranslations('common');
    const { idToken } = useAuth();
    const errorMessage = useErrorMessage();

    const [form, setForm] = useState<JobForm>(() => jobToForm(job));
    // Snapshot of the form as it was prefilled, so jobFormToEditPayload can
    // tell "started blank, still blank" (omit the key) apart from "started
    // with a value, now blanked" (send an explicit clear).
    const [initialForm, setInitialForm] = useState<JobForm>(() => jobToForm(job));
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    /*
     * Focus lands on the first FIELD, not on the header's dismiss button --
     * which is what `Modal` would otherwise pick as the first focusable
     * descendant, greeting an edit form with its own close button.
     *
     * `ui/Input` forwards its ref to the `<input>`, so this points straight at
     * the control. It used to be resolved by querying a wrapper div, which only
     * existed because the primitive did not forward refs.
     */
    const initialFocusRef = useRef<HTMLInputElement>(null);

    /*
     * Re-prefill on OPEN, not on every `job` change.
     *
     * The page hands a new `job` object down after any mutation it performs
     * (status toggle, public-listing toggle). Reacting to that identity change
     * while the dialog is open would wipe whatever the employer had typed, so
     * the reset is gated on the closed->open transition only.
     */
    const wasOpen = useRef(open);
    useEffect(() => {
        if (open && !wasOpen.current) {
            const fresh = jobToForm(job);
            setForm(fresh);
            setInitialForm(fresh);
            setError('');
        }
        wasOpen.current = open;
    }, [open, job]);

    const locked = job.applicant_count > 0;
    const update = <K extends keyof JobForm>(key: K, value: JobForm[K]) =>
        setForm((current) => ({ ...current, [key]: value }));

    const toggleDoc = (doc: DocType) => {
        if (locked) return;
        setForm((current) => ({ ...current, required_docs: { ...current.required_docs, [doc]: !current.required_docs[doc] } }));
    };
    const toggleLanguage = (value: 'any' | 'en' | 'es') => {
        setForm((current) => {
            if (value === 'any') return { ...current, language_preference: ['any'] };
            const withoutAny = current.language_preference.filter((i) => i !== 'any');
            const next = withoutAny.includes(value) ? withoutAny.filter((i) => i !== value) : [...withoutAny, value];
            return { ...current, language_preference: next.length > 0 ? next : ['any'] };
        });
    };

    const handleSubmit = async () => {
        if (!form.title.trim() || !form.location.trim() || !form.trade_category) {
            setError(t('modal.validation_required'));
            return;
        }
        if (!form.city_key && !locationDatasetFailed()) {
            setError(t('modal.location_pick_required'));
            return;
        }
        const code = validateJobNumbers(form);
        if (code === 'number') return setError(t('modal.validation_number'));
        if (code === 'pay_range') return setError(t('modal.validation_pay_range'));
        if (code === 'headcount') return setError(t('modal.validation_headcount'));
        if (validateJobLocationFields(form) === 'state_region') return setError(t('modal.validation_state_region'));
        if (Number(form.number_of_workers_needed) < job.hired_count) {
            return setError(t('modal.validation_headcount'));
        }
        setLoading(true);
        setError('');
        try {
            const updated = await updateJob(idToken!, job.id, jobFormToEditPayload(form, initialForm));
            onJobUpdated(updated);
            onClose();
        } catch (err) {
            // The backend's `field_locked` code is a domain answer this form can
            // explain precisely; everything else goes through the classifier so
            // the employer never reads a raw backend code (`err.message`).
            const code = err instanceof ApiError ? err.code : null;
            setError(
                code === 'field_locked'
                    ? t('modal.locked_note')
                    : errorMessage(err, { unknown: t('modal.edit_error') }),
            );
        } finally {
            setLoading(false);
        }
    };

    const handleClose = () => {
        if (loading) return;
        onClose();
    };

    const docLabel: Record<DocType, string> = {
        resume: t('worker_profile.doc_resume'),
        driver_license: t('worker_profile.doc_driver_license'),
    };

    const languageChipClass = (selected: boolean) =>
        [
            'cursor-pointer rounded-full border px-3 py-2 text-xs font-semibold transition-colors duration-150',
            'focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]',
            selected
                ? 'border-[var(--jale-blue-500)] bg-[var(--jale-blue-50)] text-[var(--jale-blue-700)]'
                : 'border-[var(--jale-divider)] bg-[var(--jale-input)] text-[var(--jale-ink)]',
        ].join(' ');

    const docChipClass = (selected: boolean) =>
        [
            'flex cursor-pointer items-center justify-between rounded-[10px] border px-4 py-3 text-left',
            'transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-60',
            'focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]',
            selected
                ? 'border-[var(--jale-blue-500)] bg-[var(--jale-blue-50)]'
                : 'border-[var(--jale-divider)] bg-[var(--jale-paper-2)]',
        ].join(' ');

    return (
        <Modal
            open={open}
            onClose={handleClose}
            title={t('modal.edit_title')}
            size="md"
            initialFocusRef={initialFocusRef}
            // A half-typed edit must not evaporate on a stray backdrop click.
            closeOnOverlay={false}
            footer={
                <div className="flex w-full flex-col gap-3">
                    {/* Anchored to the submit control, not floated to the top of a
                        scrolling form where a failure would be invisible at the
                        exact moment the employer is looking at the button. */}
                    {error ? (
                        <InlineFeedback tone="danger" onDismiss={() => setError('')}>
                            {error}
                        </InlineFeedback>
                    ) : null}
                    <div className="flex gap-2">
                        <Button variant="ghost" onClick={handleClose} disabled={loading} className="flex-1">
                            {t('modal.cancel')}
                        </Button>
                        <Button
                            variant="primary"
                            onClick={handleSubmit}
                            loading={loading}
                            loadingLabel={tCommon('loading')}
                            className="flex-1"
                        >
                            {t('modal.edit_save')}
                        </Button>
                    </div>
                </div>
            }
        >
            <div className="grid gap-4">
                <Field label={t('modal.job_title')} required>
                    <Input
                        ref={initialFocusRef}
                        value={form.title}
                        onChange={(e) => update('title', e.target.value)}
                    />
                </Field>
                <div className="grid gap-3 md:grid-cols-2">
                    <Field label={t('modal.location')} required>
                        <LocationPicker
                            value={form.location}
                            onChange={(v) => {
                                setForm((c) => applyLocationToJobForm(c, v));
                                // A real pick resolves the "pick a city" error; drop it
                                // immediately instead of waiting for the next save attempt.
                                if (v.cityKey) setError('');
                            }}
                        />
                    </Field>
                    <Field label={t('modal.job_type')}>
                        <Select value={form.job_type} onChange={(e) => update('job_type', e.target.value as JobForm['job_type'])} disabled={locked}>
                            <option value="full-time">{t('modal.job_type_fulltime')}</option>
                            <option value="part-time">{t('modal.job_type_parttime')}</option>
                            <option value="contract">{t('modal.job_type_contract')}</option>
                        </Select>
                    </Field>
                </div>
                <Field label={t('modal.state_region')}>
                    <Input
                        value={form.state_region}
                        onChange={(e) => update('state_region', e.target.value.toUpperCase())}
                        placeholder={t('modal.state_region_placeholder')}
                        maxLength={2}
                    />
                </Field>
                <Field label={t('modal.trade_category')} required>
                    <Select value={form.trade_category} onChange={(e) => update('trade_category', e.target.value as JobForm['trade_category'])}>
                        <option value="">{t('modal.select_placeholder')}</option>
                        {TRADE_CATEGORIES.map((trade) => (<option key={trade} value={trade}>{t(`modal.trade.${trade}`)}</option>))}
                    </Select>
                </Field>
                <Field label={t('modal.job_description')}>
                    <Textarea rows={4} value={form.description} onChange={(e) => update('description', e.target.value)} />
                </Field>
                <div className="grid gap-3 md:grid-cols-2">
                    <Field label={t('modal.pay_min')}><Input type="number" min={0} className="tabular-nums" value={form.pay_min} onChange={(e) => update('pay_min', e.target.value)} /></Field>
                    <Field label={t('modal.pay_max')}><Input type="number" min={0} className="tabular-nums" value={form.pay_max} onChange={(e) => update('pay_max', e.target.value)} /></Field>
                </div>
                <Field label={t('modal.pay_interval')}>
                    <Select value={form.pay_interval} onChange={(e) => update('pay_interval', e.target.value as PayInterval)}>
                        {PAY_INTERVALS.map((interval) => (<option key={interval} value={interval}>{t(`modal.pay_interval_option.${interval}`)}</option>))}
                    </Select>
                </Field>
                <div className="grid gap-3 md:grid-cols-2">
                    <Field label={t('modal.start_date')}><Input type="date" className="tabular-nums" value={form.start_date} onChange={(e) => update('start_date', e.target.value)} /></Field>
                    <Field label={t('modal.expected_duration')}><Input value={form.expected_duration} onChange={(e) => update('expected_duration', e.target.value)} /></Field>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                    <Field label={t('modal.shift_schedule')}><Input value={form.shift_schedule} onChange={(e) => update('shift_schedule', e.target.value)} /></Field>
                    <Field label={t('modal.number_of_workers_needed')} required>
                        <Input type="number" min={job.hired_count || 1} className="tabular-nums" value={form.number_of_workers_needed} onChange={(e) => update('number_of_workers_needed', e.target.value)} />
                    </Field>
                </div>
                <Field label={t('modal.required_experience_years')}>
                    <Input type="number" min={0} className="tabular-nums" value={form.required_experience_years} onChange={(e) => update('required_experience_years', e.target.value)} />
                </Field>
                <Field label={t('modal.language_preference')}>
                    <div className="flex flex-wrap gap-2">
                        {LANGUAGE_OPTIONS.map((lang) => (
                            <button
                                key={lang}
                                type="button"
                                aria-pressed={form.language_preference.includes(lang)}
                                onClick={() => toggleLanguage(lang)}
                                className={languageChipClass(form.language_preference.includes(lang))}
                            >
                                {t(`modal.language.${lang}`)}
                            </button>
                        ))}
                    </div>
                </Field>
                <label className="flex items-center gap-2 text-sm font-medium text-[var(--jale-ink)]">
                    <input type="checkbox" checked={form.transportation_required} onChange={(e) => update('transportation_required', e.target.checked)} />
                    {t('modal.transportation_required')}
                </label>
                <label className="flex items-center gap-2 text-sm font-medium text-[var(--jale-ink)]">
                    <input type="checkbox" checked={form.work_authorization_required} onChange={(e) => update('work_authorization_required', e.target.checked)} />
                    {t('modal.work_authorization_required')}
                </label>
                <Field label={t('modal.certifications')}>
                    <Input value={form.certifications} onChange={(e) => update('certifications', e.target.value)} />
                </Field>

                <div>
                    <p className="mb-2 text-xs font-bold uppercase tracking-wider text-[var(--jale-ink-2)]">{t('post_job_docs.subtitle')}</p>
                    {locked && <p className="mb-2 text-xs font-semibold text-[var(--jale-ink-2)]">{t('modal.locked_note')}</p>}
                    <div className="flex flex-col gap-2.5">
                        {DOC_TYPES.map((doc) => (
                            <button
                                key={doc}
                                type="button"
                                aria-pressed={form.required_docs[doc]}
                                onClick={() => toggleDoc(doc)}
                                disabled={locked}
                                className={docChipClass(form.required_docs[doc])}
                            >
                                <span className="text-sm font-medium text-[var(--jale-ink)]">{docLabel[doc]}</span>
                                <span className="text-xs font-semibold text-[var(--jale-blue-700)]">{form.required_docs[doc] ? t('post_job_docs.required_label') : t('post_job_docs.optional_label')}</span>
                            </button>
                        ))}
                    </div>
                </div>
            </div>
        </Modal>
    );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
    return (
        <div className="flex flex-col gap-1.5">
            <label className="text-xs font-bold uppercase tracking-wider text-[var(--jale-ink-2)]">{label}{required ? ' *' : ''}</label>
            {children}
        </div>
    );
}
