'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/contexts/AuthContext';
import { useErrorMessage } from '@/hooks/useErrorMessage';
import { ApiError, updateJob, type EmployerJobDetail } from '@/lib/api/employer';
import {
    type JobForm,
    jobFormToEditPayload, jobToForm, validateFullJobForm, applyLocationToJobForm,
} from '@/lib/job-form';
import { Button } from '@/components/ui/button';
import { InlineFeedback } from '@/components/ui/inline-feedback';
import { JobFormFields } from '@/components/employer/JobFormFields';
import { Modal } from '@/components/ui/modal';

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
    const tReq = useTranslations('job_requirements');
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

    const handleSubmit = async () => {
        // `validateFullJobForm` replaces this modal's own inline checks --
        // `{ minWorkers: job.hired_count }` is EditJobModal's one validation
        // rule the create/template paths don't share (an employer can't drop
        // the headcount below workers already hired). `trade_category_other_required`
        // and `shift_incomplete` both fall back onto `validation_required`
        // per `validateStepBasics`/`validateStepDetails`'s own doc comments --
        // there is no dedicated key for either yet.
        const code = validateFullJobForm(form, { minWorkers: job.hired_count });
        switch (code) {
            case null:
                break;
            case 'required':
            case 'trade_category_other_required':
            case 'shift_incomplete':
                return setError(t('modal.validation_required'));
            case 'location_pick_required':
                return setError(t('modal.location_pick_required'));
            case 'state_region':
                return setError(t('modal.validation_state_region'));
            case 'number':
                return setError(t('modal.validation_number'));
            case 'pay_range':
                return setError(t('modal.validation_pay_range'));
            case 'headcount':
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
            // explain precisely; `city_required`/`requirements_tier_overlap` are
            // the requirements-picker-adjacent 400s (see PostJobModal); everything
            // else goes through the classifier so the employer never reads a raw
            // backend code (`err.message`).
            const code = err instanceof ApiError ? err.code : null;
            if (code === 'field_locked') {
                setError(t('modal.locked_note'));
            } else if (code === 'city_required') {
                setError(tReq('errors.city_required'));
            } else if (code === 'requirements_tier_overlap') {
                setError(tReq('errors.tier_overlap'));
            } else {
                setError(errorMessage(err, { unknown: t('modal.edit_error') }));
            }
        } finally {
            setLoading(false);
        }
    };

    const handleClose = () => {
        if (loading) return;
        onClose();
    };

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
                <JobFormFields
                    form={form}
                    onUpdate={update}
                    onLocationChange={(v) => {
                        setForm((c) => applyLocationToJobForm(c, v));
                        // A real pick resolves the "pick a city" error; drop it
                        // immediately instead of waiting for the next save attempt.
                        if (v.cityKey) setError('');
                    }}
                    locked={locked}
                    minWorkers={job.hired_count || 1}
                    titleRef={initialFocusRef}
                />
            </div>
        </Modal>
    );
}

