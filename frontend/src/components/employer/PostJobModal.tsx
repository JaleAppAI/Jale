'use client';
import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import { useErrorMessage } from '@/hooks/useErrorMessage';
import { ApiError, createJob, listJobTemplates, saveJobTemplate, Job, JobTemplate } from '@/lib/api/employer';
import {
  LANGUAGE_OPTIONS, TRADE_CATEGORIES, PAY_INTERVALS,
  type PayInterval, type JobForm,
  initialForm, jobFormToCreatePayload, jobFormFromTemplatePayload, validateJobNumbers, applyLocationToJobForm, validateJobLocationFields,
} from '@/lib/job-form';
import { Button } from '@/components/ui/button';
import { CheckboxCard } from '@/components/ui/checkbox-card';
import { DescriptionHelper } from '@/components/employer/DescriptionHelper';
import { Icon } from '@/components/ui/icon';
import { InlineFeedback } from '@/components/ui/inline-feedback';
import { Input } from '@/components/ui/input';
import { LocationPicker } from '@/components/ui/LocationPicker';
import { Modal } from '@/components/ui/modal';
import { PayReferenceHint } from '@/components/PayReferenceHint';
import { RequirementsPicker } from '@/components/employer/RequirementsPicker';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { locationDatasetFailed } from '@/lib/location-search';

interface Props {
  open: boolean;
  onClose: () => void;
  onJobCreated: (job: Job) => void;
}

type Step = 1 | 2 | 3;

/** The wizard's shape, in one place, so the indicator and the panels agree. */
const STEPS: readonly Step[] = [1, 2, 3];
const STEP_KEYS: Record<Step, 'basics' | 'details' | 'documents'> = {
  1: 'basics',
  2: 'details',
  3: 'documents',
};

/**
 * Three-step "post a job" wizard.
 *
 * The FLOW is unchanged — same three steps, same fields, same
 * `lib/job-form.ts` validation, same payload. What changed is everything
 * around it:
 *
 *  - It sits in the foundation `Modal`, so focus trapping, Escape, the ink
 *    backdrop, the scroll lock and returning focus to the "Post job" button are
 *    handled once, centrally, instead of being missing (the old overlay had a
 *    literal `rgba()` scrim, a bare `x` glyph for a close button, no focus
 *    management at all, and a backdrop that closed the dialog even when a drag
 *    merely ENDED outside the panel).
 *  - "Step 1 of 3" became a real indicator: three named stops, the completed
 *    ones walkable backwards, the current one marked `aria-current="step"`.
 *    A user could previously see a step counter but never the shape of what
 *    they had signed up for.
 *  - Entering a step moves focus to that step's heading, so keyboard and screen
 *    reader users land at the top of the new panel instead of being left on a
 *    "Next" button while the content silently changes behind them.
 *  - Failures render as one `InlineFeedback` immediately above the footer — as
 *    close to the control that caused them as the layout allows — and the copy
 *    is CLASSIFIED (`useErrorMessage`), never `err.message`, which is a backend
 *    error code and not a sentence.
 *
 * The `job_limit_reached` path keeps its own message and its billing link:
 * that failure is not "something went wrong", it is a plan decision with one
 * specific way out.
 */
export function PostJobModal({ open, onClose, onJobCreated }: Props) {
  const t = useTranslations('employer_dashboard');
  const tCommon = useTranslations('common');
  const tBilling = useTranslations('billing');
  const tReq = useTranslations('job_requirements');
  const { idToken } = useAuth();
  // `enabled: false` — the DASHBOARD owns the sign-in redirect for this route.
  // All this call wants is the legal-wall router, so a create that trips the
  // wall goes to /legal/accept instead of showing an error nobody can act on.
  const { handleLegalWall } = useRequireAuth({ enabled: false });
  const errorMessage = useErrorMessage();

  const [step, setStep] = useState<Step>(1);
  const [form, setForm] = useState<JobForm>(initialForm);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [limitReached, setLimitReached] = useState(false);
  // Freezes the description Textarea while `DescriptionHelper`'s Generate
  // call is in flight -- otherwise a manual edit made mid-flight would be
  // silently overwritten seconds later by the eventual success response.
  const [descriptionGenerating, setDescriptionGenerating] = useState(false);

  // Template state. Templates are a convenience layer on top of job
  // creation: a failure to load or save one must never block posting a job.
  const [templates, setTemplates] = useState<JobTemplate[]>([]);
  const [checkCity, setCheckCity] = useState(false);
  const [saveAsTemplate, setSaveAsTemplate] = useState(false);
  const [templateName, setTemplateName] = useState('');
  const [templateNotice, setTemplateNotice] = useState<'' | 'limit' | 'name_taken'>('');
  const [templateLimit, setTemplateLimit] = useState<number | null>(null);

  const headingRef = useRef<HTMLHeadingElement>(null);
  const feedbackRef = useRef<HTMLDivElement>(null);
  // Once the template save succeeds, later submits of the SAME wizard run
  // (e.g. after a failed job post) carry this id so the backend overwrites
  // that template instead of 409ing against our own first save.
  const savedTemplateIdRef = useRef<string | null>(null);

  // Silent background load whenever the modal opens -- the wizard must work
  // exactly the same with zero templates, so any failure here is swallowed.
  useEffect(() => {
    if (!open || !idToken) return;
    let cancelled = false;
    listJobTemplates(idToken)
      .then((list) => {
        if (!cancelled) setTemplates(list);
      })
      .catch(() => {
        // Templates are an enhancement; the modal must work without them.
      });
    return () => {
      cancelled = true;
    };
  }, [open, idToken]);

  // Entering a step hands focus to its heading. The heading is `tabIndex={-1}`
  // (focusable programmatically, not in the tab order), which is the standard
  // way to move a reader to a newly revealed region without inventing a stop.
  useEffect(() => {
    if (!open) return;
    headingRef.current?.focus();
  }, [open, step]);

  // A failure below the fold is a failure the user does not know about. The
  // banner has `role="alert"` for screen readers; this is the visual half.
  useEffect(() => {
    if (!error) return;
    feedbackRef.current?.scrollIntoView({ block: 'nearest' });
  }, [error]);

  const update = <K extends keyof JobForm>(key: K, value: JobForm[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const handleClose = () => {
    setStep(1);
    setForm(initialForm);
    setError('');
    setLimitReached(false);
    setCheckCity(false);
    setSaveAsTemplate(false);
    setTemplateName('');
    setTemplateNotice('');
    setTemplateLimit(null);
    setDescriptionGenerating(false);
    savedTemplateIdRef.current = null;
    onClose();
  };

  const applyTemplate = (template: JobTemplate) => {
    const { form: prefilled, cityPrefilled } = jobFormFromTemplatePayload(template.payload);
    setForm(prefilled);
    setCheckCity(cityPrefilled);
  };

  const toggleLanguage = (value: 'any' | 'en' | 'es') => {
    setForm((current) => {
      if (value === 'any') return { ...current, language_preference: ['any'] };
      const withoutAny = current.language_preference.filter((item) => item !== 'any');
      const next = withoutAny.includes(value)
        ? withoutAny.filter((item) => item !== value)
        : [...withoutAny, value];
      return { ...current, language_preference: next.length > 0 ? next : ['any'] };
    });
  };

  const validateCurrentStep = (): string | null => {
    if (step === 1) {
      if (!form.title.trim() || !form.location.trim() || !form.trade_category) return t('modal.validation_required');
      if (!form.city_key && !locationDatasetFailed()) return t('modal.location_pick_required');
      if (validateJobLocationFields(form) === 'state_region') return t('modal.validation_state_region');
      return null;
    }
    if (step === 2) {
      const code = validateJobNumbers(form);
      if (code === 'number') return t('modal.validation_number');
      if (code === 'pay_range') return t('modal.validation_pay_range');
      if (code === 'headcount') return t('modal.validation_headcount');
    }
    return null;
  };

  const nextStep = () => {
    const validationError = validateCurrentStep();
    if (validationError) {
      setError(validationError);
      return;
    }
    setError('');
    setLimitReached(false);
    setStep((current) => (current === 1 ? 2 : 3));
  };

  const previousStep = () => {
    setError('');
    setLimitReached(false);
    setStep((current) => (current === 3 ? 2 : 1));
  };

  /**
   * The indicator's only navigation: back to a step already completed. Forward
   * jumps stay closed, because each forward transition is what runs that step's
   * validation — skipping one would let an invalid step through.
   */
  const goBackToStep = (target: Step) => {
    if (target >= step) return;
    setError('');
    setLimitReached(false);
    setStep(target);
  };

  const handleSubmit = async () => {
    const validationError = validateCurrentStep();
    if (validationError) {
      setError(validationError);
      return;
    }

    const name = templateName.trim();
    // Pre-check the template name against the loaded list BEFORE any network
    // call: once the job posts, the modal closes and a failed template save
    // has nowhere left to surface. Catching the collision here keeps it
    // fixable; the server 409 below remains the backstop for stale lists.
    if (
      saveAsTemplate && name &&
      templates.some((tpl) => tpl.name === name && tpl.id !== savedTemplateIdRef.current)
    ) {
      setTemplateNotice('name_taken');
      return;
    }
    setLoading(true);
    setError('');
    setLimitReached(false);
    setTemplateNotice('');

    if (saveAsTemplate && name) {
      try {
        const saved = await saveJobTemplate(idToken!, {
          ...(savedTemplateIdRef.current ? { id: savedTemplateIdRef.current } : {}),
          name,
          payload: jobFormToCreatePayload(form),
        });
        savedTemplateIdRef.current = saved.id;
        setTemplates((current) => [saved, ...current.filter((tpl) => tpl.id !== saved.id)]);
      } catch (err) {
        // Template failures never block the job post -- surface the notice
        // and keep going.
        if (err instanceof ApiError && err.code === 'template_limit_reached') {
          setTemplateNotice('limit');
          setTemplateLimit(err.payload.template_limit ?? null);
        } else if (err instanceof ApiError && err.code === 'template_name_taken') {
          setTemplateNotice('name_taken');
        }
      }
    }

    try {
      const job = await createJob(idToken!, jobFormToCreatePayload(form));
      onJobCreated(job);
      handleClose();
    } catch (err) {
      try {
        handleLegalWall(err, '/employer/dashboard');
        // Redirected to the legal wall; there is no error to render here.
        return;
      } catch {
        // Not a legal wall — fall through to the normal failure paths.
      }

      // The typed `job_limit_reached` code is the one failure with its own
      // story: the plan's ceiling, and the page that lifts it. `city_required`
      // and `requirements_tier_overlap` are the two create-time 400s the
      // requirements picker can provoke (a create with no picked city; a key
      // landing in both a required and an optional array -- should not
      // happen through the picker's own UI, but is the backend's own
      // validation, not a generic "something went wrong"). Everything else is
      // classified into the app's shared, bilingual failure sentences —
      // `modal.error` stays as the override for the genuinely unclassifiable.
      if (err instanceof ApiError && err.code === 'job_limit_reached') {
        setLimitReached(true);
        setError(tBilling('limit_reached.modal_message', {
          limit: err.payload.active_job_limit ?? 0,
        }));
      } else if (err instanceof ApiError && err.code === 'city_required') {
        setError(tReq('errors.city_required'));
      } else if (err instanceof ApiError && err.code === 'requirements_tier_overlap') {
        setError(tReq('errors.tier_overlap'));
      } else {
        setError(errorMessage(err, { unknown: t('modal.error') }));
      }
    } finally {
      setLoading(false);
    }
  };

  const stepHint =
    step === 1
      ? t('modal.steps.basics_hint')
      : step === 2
        ? t('modal.steps.details_hint')
        // Step 3's sentence already lives with the rest of the docs-step copy.
        : t('post_job_docs.subtitle');

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={t('modal.title')}
      size="md"
      footer={
        <div className="flex w-full items-center gap-2">
          {step === 1 ? (
            <Button variant="ghost" onClick={handleClose} className="flex-1">
              {t('modal.cancel')}
            </Button>
          ) : (
            <Button variant="ghost" onClick={previousStep} disabled={loading} className="flex-1">
              {t('post_job_docs.back')}
            </Button>
          )}
          {/* This was the first call site to move off the old `deep` variant,
              which rendered navy on the dark card and all but disappeared. That
              variant has since been retired outright (see `ui/button`), so
              `primary` is now simply the only CTA fill there is. */}
          {step < 3 ? (
            <Button variant="primary" onClick={nextStep} className="flex-1">
              {t('modal.next')}
            </Button>
          ) : (
            <Button
              variant="primary"
              onClick={handleSubmit}
              loading={loading}
              loadingLabel={tCommon('loading')}
              className="flex-1"
            >
              {t('post_job_docs.submit')}
            </Button>
          )}
        </div>
      }
    >
      <nav aria-label={t('modal.steps.aria_label')} className="mb-5">
        <p className="sr-only">{t('modal.step_label', { current: step, total: STEPS.length })}</p>
        <ol className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          {STEPS.map((n) => {
            const label = t(`modal.steps.${STEP_KEYS[n]}`);
            const done = n < step;
            const current = n === step;

            return (
              <li key={n} className="flex min-w-0 items-center gap-2">
                {done ? (
                  <button
                    type="button"
                    onClick={() => goBackToStep(n)}
                    className="inline-flex min-w-0 items-center gap-1.5 rounded-full px-1 py-0.5 text-xs font-bold text-[var(--jale-ink)] transition-colors hover:underline focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
                  >
                    <span aria-hidden className="size-[7px] shrink-0 rounded-full bg-[var(--jale-success)]" />
                    <span className="truncate">{label}</span>
                    <span className="sr-only"> — {t('modal.steps.completed')}</span>
                  </button>
                ) : (
                  <span
                    aria-current={current ? 'step' : undefined}
                    className={[
                      'inline-flex min-w-0 items-center gap-1.5 px-1 py-0.5 text-xs',
                      current
                        ? 'font-extrabold text-[var(--jale-ink)]'
                        : 'font-semibold text-[var(--jale-ink-2)]',
                    ].join(' ')}
                  >
                    <span
                      aria-hidden
                      className={`size-[7px] shrink-0 rounded-full ${
                        current ? 'bg-[var(--jale-blue-500)]' : 'bg-[var(--jale-divider)]'
                      }`}
                    />
                    <span className="truncate">{label}</span>
                  </span>
                )}

                {n < STEPS.length ? (
                  <span aria-hidden className="h-px w-4 shrink-0 bg-[var(--jale-divider)]" />
                ) : null}
              </li>
            );
          })}
        </ol>
      </nav>

      <div className="mb-4">
        <h3
          ref={headingRef}
          tabIndex={-1}
          className="text-base font-extrabold text-[var(--jale-ink)] outline-none"
        >
          {t(`modal.steps.${STEP_KEYS[step]}`)}
        </h3>
        <p className="mt-1 text-sm text-[var(--jale-ink-2)]">{stepHint}</p>
      </div>

      {step === 1 && (
        <div className="grid gap-4">
          {templates.length > 0 ? (
            <Field label={t('modal.template_select_label')}>
              <div className="flex items-center gap-2">
                <Select
                  value=""
                  onChange={(e) => {
                    const picked = templates.find((tpl) => tpl.id === e.target.value);
                    if (picked) applyTemplate(picked);
                  }}
                >
                  <option value="">{t('modal.template_select_placeholder')}</option>
                  {templates.map((tpl) => (<option key={tpl.id} value={tpl.id}>{tpl.name}</option>))}
                </Select>
                <Link href="/employer/templates" className="shrink-0 text-xs font-semibold text-[var(--jale-blue-700)] hover:underline">
                  {t('templates.manage_link')}
                </Link>
              </div>
            </Field>
          ) : (
            // No templates yet: the picker would be empty, but the page link
            // stays discoverable from the wizard, not just the sidebar.
            <div className="flex justify-end">
              <Link href="/employer/templates" className="text-xs font-semibold text-[var(--jale-blue-700)] hover:underline">
                {t('templates.manage_link')}
              </Link>
            </div>
          )}
          <Field label={t('modal.job_title')} required>
            <Input value={form.title} onChange={(e) => update('title', e.target.value)} placeholder={t('modal.job_title_placeholder')} />
          </Field>
          <div className="grid gap-3 md:grid-cols-2">
            <Field label={t('modal.location')} required>
              <div className={checkCity ? 'rounded-[10px] ring-2 ring-[var(--jale-warning)]' : undefined}>
                <LocationPicker
                  value={form.location}
                  placeholder={t('modal.location_placeholder')}
                  onChange={(v) => {
                    setForm((c) => applyLocationToJobForm(c, v));
                    // Any location edit resolves the "verify the
                    // prefilled city" nudge, same as clearing the error.
                    setCheckCity(false);
                    // A real pick resolves the "pick a city" error; drop it
                    // immediately instead of waiting for the next step.
                    if (v.cityKey) setError('');
                  }}
                />
              </div>
              {checkCity && (
                <p className="mt-1 rounded-md bg-[var(--jale-warning-bg)] px-2 py-1 text-xs font-semibold text-[var(--jale-warning)]">{t('modal.template_check_city')}</p>
              )}
            </Field>
            <Field label={t('modal.job_type')}>
              <Select value={form.job_type} onChange={(e) => update('job_type', e.target.value as JobForm['job_type'])}>
                <option value="full-time">{t('modal.job_type_fulltime')}</option>
                <option value="part-time">{t('modal.job_type_parttime')}</option>
                <option value="contract">{t('modal.job_type_contract')}</option>
              </Select>
            </Field>
          </div>
          <Field label={t('modal.trade_category')} required>
            <Select value={form.trade_category} onChange={(e) => update('trade_category', e.target.value as JobForm['trade_category'])}>
              <option value="">{t('modal.select_placeholder')}</option>
              {TRADE_CATEGORIES.map((trade) => (
                <option key={trade} value={trade}>{t(`modal.trade.${trade}`)}</option>
              ))}
            </Select>
          </Field>
          <Field label={t('modal.job_description')}>
            <Textarea
              rows={4}
              value={form.description}
              onChange={(e) => update('description', e.target.value)}
              placeholder={t('modal.description_placeholder')}
              disabled={descriptionGenerating}
            />
            <DescriptionHelper
              form={form}
              onDescriptionChange={(value) => update('description', value)}
              onGeneratingChange={setDescriptionGenerating}
            />
          </Field>
        </div>
      )}

      {step === 2 && (
        <div className="grid gap-4">
          <div className="grid gap-3 md:grid-cols-2">
            <Field label={t('modal.pay_min')}>
              <Input type="number" min={0} value={form.pay_min} onChange={(e) => update('pay_min', e.target.value)} />
            </Field>
            <Field label={t('modal.pay_max')}>
              <Input type="number" min={0} value={form.pay_max} onChange={(e) => update('pay_max', e.target.value)} />
            </Field>
          </div>
          <Field label={t('modal.pay_interval')}>
            <Select value={form.pay_interval} onChange={(e) => update('pay_interval', e.target.value as PayInterval)}>
              {PAY_INTERVALS.map((interval) => (
                <option key={interval} value={interval}>{t(`modal.pay_interval_option.${interval}`)}</option>
              ))}
            </Select>
          </Field>
          <PayReferenceHint trade={form.trade_category} cityKey={form.city_key} variant="employer" />
          <div className="grid gap-3 md:grid-cols-2">
            <Field label={t('modal.start_date')}>
              <Input type="date" value={form.start_date} onChange={(e) => update('start_date', e.target.value)} />
            </Field>
            <Field label={t('modal.expected_duration')}>
              <Input value={form.expected_duration} onChange={(e) => update('expected_duration', e.target.value)} placeholder={t('modal.duration_placeholder')} />
            </Field>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <Field label={t('modal.shift_schedule')}>
              <Input value={form.shift_schedule} onChange={(e) => update('shift_schedule', e.target.value)} placeholder={t('modal.shift_placeholder')} />
            </Field>
            <Field label={t('modal.number_of_workers_needed')} required>
              <Input type="number" min={1} value={form.number_of_workers_needed} onChange={(e) => update('number_of_workers_needed', e.target.value)} />
            </Field>
          </div>
          <Field label={t('modal.required_experience_years')}>
            <Input type="number" min={0} value={form.required_experience_years} onChange={(e) => update('required_experience_years', e.target.value)} />
          </Field>
          <Field label={t('modal.language_preference')}>
            <div className="flex flex-wrap gap-2">
              {LANGUAGE_OPTIONS.map((lang) => {
                const selected = form.language_preference.includes(lang);
                return (
                  <button
                    key={lang}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => toggleLanguage(lang)}
                    className={[
                      'rounded-full border px-3.5 py-2 text-xs font-bold transition-colors',
                      'focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]',
                      selected
                        ? 'border-[var(--jale-blue-500)] bg-[var(--jale-blue-50)] text-[var(--jale-blue-700)]'
                        : 'border-[var(--jale-divider)] bg-[var(--jale-card)] text-[var(--jale-ink)] hover:bg-[var(--jale-paper-2)]',
                    ].join(' ')}
                  >
                    {t(`modal.language.${lang}`)}
                  </button>
                );
              })}
            </div>
          </Field>
          {/* `CheckboxCard` is the app's boolean toggle (employer signup and
              the employer profile both use it). Work authorization moved off
              this raw checkbox onto the requirements picker's own
              `work_authorization` row (step 3) -- see `jobFormToBasePayload`,
              which derives the legacy boolean from that row's state. */}
          <div className="grid gap-2">
            <CheckboxCard
              checked={form.transportation_required}
              label={t('modal.transportation_required')}
              onChange={() => update('transportation_required', !form.transportation_required)}
            />
          </div>
          <Field label={t('modal.certifications')}>
            <Input value={form.certifications} onChange={(e) => update('certifications', e.target.value)} placeholder={t('modal.certifications_placeholder')} />
          </Field>
        </div>
      )}

      {step === 3 && (
        <div className="grid gap-5">
        <RequirementsPicker
          requirements={form.requirements}
          onChange={(next) => setForm((current) => ({ ...current, requirements: next }))}
          certifications={form.certifications}
        />

        <div className="rounded-[10px] border border-[var(--jale-divider)] p-4">
          <label className="flex items-center gap-2 text-sm font-medium text-[var(--jale-ink)]">
            <input
              type="checkbox"
              checked={saveAsTemplate}
              onChange={(e) => setSaveAsTemplate(e.target.checked)}
            />
            {t('modal.template_save_toggle')}
          </label>
          {saveAsTemplate && (
            <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
              <Input
                value={templateName}
                onChange={(e) => setTemplateName(e.target.value)}
                placeholder={t('modal.template_name_placeholder')}
                className="flex-1"
              />
            </div>
          )}
          {templateNotice === 'name_taken' && (
            <p className="mt-2 text-xs font-semibold text-[var(--jale-danger)]">{t('modal.template_name_taken')}</p>
          )}
          {templateNotice === 'limit' && (
            <div className="mt-2">
              <InlineFeedback tone="danger">
                <span className="block">
                  {templateLimit != null
                    ? t('modal.template_limit_reached_n', { limit: templateLimit })
                    : t('modal.template_limit_reached')}
                </span>
                <Link
                  href="/employer/billing"
                  onClick={handleClose}
                  className="mt-2 inline-flex items-center gap-1.5 text-xs font-bold underline underline-offset-2"
                >
                  <Icon name="spark" />
                  {tBilling('limit_reached.cta')}
                </Link>
              </InlineFeedback>
            </div>
          )}
        </div>
        </div>
      )}

      {error ? (
        <div ref={feedbackRef} className="mt-5">
          <InlineFeedback tone="danger">
            <span className="block">{error}</span>
            {limitReached ? (
              <Link
                href="/employer/billing"
                onClick={handleClose}
                className="mt-2 inline-flex items-center gap-1.5 text-xs font-bold underline underline-offset-2"
              >
                <Icon name="spark" />
                {tBilling('limit_reached.cta')}
              </Link>
            ) : null}
          </InlineFeedback>
        </div>
      ) : null}
    </Modal>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs font-semibold uppercase tracking-wider text-[var(--jale-ink-2)]">
        {label}{required ? ' *' : ''}
      </label>
      {children}
    </div>
  );
}
