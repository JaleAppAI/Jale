'use client';

import { useId, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent, ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/contexts/AuthContext';
import { useErrorMessage } from '@/hooks/useErrorMessage';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';
import { ApiError } from '@/lib/api/errors';
import { updateHireDetails } from '@/lib/api/employer';
import type { HireDetails } from '@/lib/api/worker';
import {
  HIRE_DETAILS_FIELDS,
  HIRE_DETAILS_LIMITS,
  hireDetailsFormFrom,
  validateHireDetails,
  type HireDetailsField,
  type HireDetailsFieldError,
  type HireDetailsForm as HireDetailsFormState,
} from '@/lib/hire-details';

/** A field's problem: one of the K4.2 rules, or a field the server refused (`invalid_hire_details`). */
type FieldProblem = HireDetailsFieldError | 'server';
type FieldErrors = Partial<Record<HireDetailsField, FieldProblem>>;

/**
 * The employer's start details for one hire (F19, contract K4.2): when, where,
 * who to ask for, and anything else the first day needs. Saving shows them on
 * the worker's application, and every change after the first also reaches the
 * worker.
 */
export function HireDetailsForm({
  open,
  onClose,
  jobId,
  workerId,
  workerName,
  initial,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  jobId: string;
  workerId: string;
  workerName: string;
  initial: HireDetails | null;
  onSaved: (details: HireDetails | null) => void;
}) {
  const t = useTranslations('employer_applicants.hire_details');
  const tCommon = useTranslations('common');
  const { idToken } = useAuth();
  const { handleLegalWall } = useRequireAuth();
  const toast = useToast();
  const errorMessage = useErrorMessage();

  const formId = useId();
  const startDateId = useId();
  const locationId = useId();
  const contactNameId = useId();
  const contactPhoneId = useId();
  const notesId = useId();
  const ids: Record<HireDetailsField, string> = {
    start_date: startDateId,
    report_location: locationId,
    contact_name: contactNameId,
    contact_phone: contactPhoneId,
    notes: notesId,
  };

  const [form, setForm] = useState<HireDetailsFormState>(() => hireDetailsFormFrom(initial));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const fieldRefs = useRef<Partial<Record<HireDetailsField, HTMLInputElement | HTMLTextAreaElement | null>>>({});

  function problemText(field: HireDetailsField, problem: FieldProblem): string {
    if (problem === 'date') return t('error_date');
    if (problem === 'phone') return t('error_phone');
    if (problem === 'too_long' && field !== 'start_date') return t('error_too_long', { max: HIRE_DETAILS_LIMITS[field] });
    return t('error_field');
  }

  function showFieldErrors(found: FieldErrors) {
    setErrors(found);
    const first = HIRE_DETAILS_FIELDS.find((field) => found[field] !== undefined);
    if (first) fieldRefs.current[first]?.focus();
  }

  const update = (field: HireDetailsField) => (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const { value } = event.target;
    setForm((prev) => ({ ...prev, [field]: value }));
    if (errors[field] !== undefined) {
      setErrors((prev) => {
        const next = { ...prev };
        delete next[field];
        return next;
      });
    }
  };

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // A ref, not the state: a double click lands twice in the same frame.
    if (!idToken || savingRef.current) return;
    const result = validateHireDetails(form);
    if (!result.ok) {
      setFormError(null);
      showFieldErrors(result.errors);
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setErrors({});
    setFormError(null);
    try {
      const saved = await updateHireDetails(idToken, jobId, workerId, result.payload);
      onSaved(saved);
      toast.success(t('saved'));
      onClose();
    } catch (err) {
      try {
        handleLegalWall(err, '/employer/applicants');
        return;
      } catch {
        // Not the legal wall: one of the failures below.
      }
      if (err instanceof ApiError && err.code === 'invalid_hire_details') {
        const refused = (err.payload.fields ?? []).filter(
          (name): name is HireDetailsField => (HIRE_DETAILS_FIELDS as readonly string[]).includes(name),
        );
        if (refused.length > 0) {
          showFieldErrors(Object.fromEntries(refused.map((name) => [name, 'server' as const])));
        } else {
          setFormError(errorMessage(err));
        }
      } else if (err instanceof ApiError && err.code === 'not_hired') {
        setFormError(t('error_not_hired'));
      } else if (err instanceof ApiError && err.code === 'not_found') {
        setFormError(t('error_not_found'));
      } else {
        setFormError(errorMessage(err));
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  const describedBy = (field: HireDetailsField, hintId?: string) =>
    [hintId, errors[field] !== undefined ? `${ids[field]}-error` : undefined].filter(Boolean).join(' ') || undefined;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('title', { name: workerName })}
      size="md"
      // A half-filled form must not vanish on a stray backdrop click.
      closeOnOverlay={false}
      footer={
        <div className="flex w-full flex-wrap justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
            {t('cancel')}
          </Button>
          <Button type="submit" form={formId} loading={saving} loadingLabel={tCommon('loading')}>
            {t('save')}
          </Button>
        </div>
      }
    >
      <form id={formId} onSubmit={(event) => void handleSubmit(event)} noValidate className="grid gap-4">
        <p className="text-sm text-[var(--jale-ink-2)]">{t('intro', { name: workerName })}</p>

        <Field id={ids.start_date} label={t('start_date')} error={errors.start_date ? problemText('start_date', errors.start_date) : null}>
          <Input
            id={ids.start_date}
            ref={(el) => { fieldRefs.current.start_date = el; }}
            type="date"
            name="start_date"
            value={form.start_date}
            onChange={update('start_date')}
            autoComplete="off"
            aria-invalid={errors.start_date ? true : undefined}
            aria-describedby={describedBy('start_date')}
          />
        </Field>

        <Field id={ids.report_location} label={t('report_location')} error={errors.report_location ? problemText('report_location', errors.report_location) : null}>
          <Input
            id={ids.report_location}
            ref={(el) => { fieldRefs.current.report_location = el; }}
            name="report_location"
            maxLength={HIRE_DETAILS_LIMITS.report_location}
            value={form.report_location}
            onChange={update('report_location')}
            placeholder={t('report_location_placeholder')}
            autoComplete="off"
            aria-invalid={errors.report_location ? true : undefined}
            aria-describedby={describedBy('report_location')}
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field id={ids.contact_name} label={t('contact_name')} error={errors.contact_name ? problemText('contact_name', errors.contact_name) : null}>
            <Input
              id={ids.contact_name}
              ref={(el) => { fieldRefs.current.contact_name = el; }}
              name="contact_name"
              maxLength={HIRE_DETAILS_LIMITS.contact_name}
              value={form.contact_name}
              onChange={update('contact_name')}
              autoComplete="off"
              aria-invalid={errors.contact_name ? true : undefined}
              aria-describedby={describedBy('contact_name')}
            />
          </Field>

          <Field
            id={ids.contact_phone}
            label={t('contact_phone')}
            hint={t('contact_phone_hint')}
            error={errors.contact_phone ? problemText('contact_phone', errors.contact_phone) : null}
          >
            <Input
              id={ids.contact_phone}
              ref={(el) => { fieldRefs.current.contact_phone = el; }}
              type="tel"
              inputMode="tel"
              name="contact_phone"
              maxLength={HIRE_DETAILS_LIMITS.contact_phone}
              value={form.contact_phone}
              onChange={update('contact_phone')}
              autoComplete="off"
              aria-invalid={errors.contact_phone ? true : undefined}
              aria-describedby={describedBy('contact_phone', `${ids.contact_phone}-hint`)}
            />
          </Field>
        </div>

        <Field id={ids.notes} label={t('notes')} error={errors.notes ? problemText('notes', errors.notes) : null}>
          <Textarea
            id={ids.notes}
            ref={(el) => { fieldRefs.current.notes = el; }}
            name="notes"
            rows={4}
            maxLength={HIRE_DETAILS_LIMITS.notes}
            value={form.notes}
            onChange={update('notes')}
            placeholder={t('notes_placeholder')}
            autoComplete="off"
            aria-invalid={errors.notes ? true : undefined}
            aria-describedby={describedBy('notes')}
          />
        </Field>

        {formError ? (
          <p role="alert" className="text-sm font-medium text-[var(--jale-danger-text)]">{formError}</p>
        ) : null}
      </form>
    </Modal>
  );
}

/** A labelled field with an optional hint and its inline error (ids `<id>-hint`, `<id>-error`). */
function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error: string | null;
  children: ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-[var(--jale-ink-2)]">
        {label}
      </label>
      {children}
      {hint ? <p id={`${id}-hint`} className="mt-1 text-xs text-[var(--jale-ink-2)]">{hint}</p> : null}
      {error ? (
        <p id={`${id}-error`} className="mt-1 text-xs font-medium text-[var(--jale-danger-text)]">{error}</p>
      ) : null}
    </div>
  );
}
